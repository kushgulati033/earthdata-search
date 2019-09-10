import jwt from 'jsonwebtoken'
import simpleOAuth2 from 'simple-oauth2'
import { getEdlConfig } from '../util/configUtil'
import { getSecretEarthdataConfig } from '../../../sharedUtils/config'
import { cmrEnv } from '../../../sharedUtils/cmrEnv'
import { isWarmUp } from '../util/isWarmup'
import { getDbConnection } from '../util/database/getDbConnection'

/**
 * Generate AuthPolicy for the Authorizer, and attach the JWT
 * @param {String} username username of authenticated uset
 * @param {Object} jwtToken JWT containing EDL token
 * @param {String} effect
 * @param {Object} resource
 */
const generatePolicy = (username, jwtToken, effect, resource) => {
  const authResponse = {}
  authResponse.principalId = username
  authResponse.context = { jwtToken }

  if (effect && resource) {
    const policyDocument = {}
    policyDocument.Version = '2012-10-17'
    policyDocument.Statement = []
    const statementOne = {}
    statementOne.Action = 'execute-api:Invoke'
    statementOne.Effect = effect
    statementOne.Resource = resource
    policyDocument.Statement[0] = statementOne

    authResponse.policyDocument = policyDocument
  }

  return authResponse
}

// Knex database connection object
let dbConnection = null

/**
 * API Gateway Authorizer to verify requets are authenticated
 */
const edlAuthorizer = async (event) => {
  // Prevent execution if the event source is the warmer
  if (await isWarmUp(event)) return false

  const edlConfig = await getEdlConfig()

  if (!event.authorizationToken) {
    throw new Error('Unauthorized')
  }

  // event.authorizationToken comes in as `Bearer: asdf.qwer.hjkl` but we only need the actual token
  const tokenParts = event.authorizationToken.split(' ')
  const jwtToken = tokenParts[1]

  try {
    // Retrieve a connection to the database
    dbConnection = await getDbConnection(dbConnection)

    // Pull the secret used to encrypt our jwtTokens
    const { secret } = getSecretEarthdataConfig(cmrEnv())

    return jwt.verify(jwtToken, secret, async (verifyError, decodedJwtToken) => {
      if (verifyError) {
        // This suggests that the token has been tampered with
        console.log(`JWT Token Invalid. ${verifyError}`)

        throw new Error('Unauthorized')
      }

      const {
        id: userId,
        username
      } = decodedJwtToken

      // Retrieve the authenticated users' access tokens from the database
      const existingUserTokens = await dbConnection('user_tokens')
        .select([
          'id',
          'access_token',
          'refresh_token',
          'expires_at'
        ])
        .where({ user_id: userId })
        .orderBy('created_at', 'DESC')

      if (existingUserTokens.length === 0) {
        throw new Error('Unauthorized')
      }

      // In the off chance there are more than one, return the most recent token
      const [mostRecentToken] = existingUserTokens

      const {
        id: tokenId,
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt
      } = mostRecentToken

      const oauth2 = simpleOAuth2.create(edlConfig)
      const oauthToken = oauth2.accessToken.create({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt
      })

      if (oauthToken.expired()) {
        try {
          // Remove the expired token
          await dbConnection('user_tokens')
            .where({ id: tokenId })
            .del()

          const refreshedToken = await oauthToken.refresh()

          console.log(`Access token refreshed successfully for ${username}`)

          const {
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_at: expiresAt
          } = refreshedToken

          await dbConnection('user_tokens').insert({
            user_id: userId,
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_at: expiresAt,
            environment: cmrEnv()
          })
        } catch (error) {
          console.log('Error refreshing access token: ', error.message)

          throw new Error('Unauthorized')
        }
      }

      return generatePolicy(username, jwtToken, 'Allow', event.methodArn)
    })
  } catch (err) {
    console.log('Authorizer error. Invalid token', err)

    throw new Error('Unauthorized')
  }
}

export default edlAuthorizer
