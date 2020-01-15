'use strict';

// reference: 
// https://github.com/serverless/examples/blob/master/aws-node-auth0-cognito-custom-authorizers-api/auth.js
// https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html
// https://aws.amazon.com/premiumsupport/knowledge-center/decode-verify-cognito-json-token/
// https://github.com/awslabs/aws-support-tools/tree/master/Cognito/decode-verify-jwt
// https://www.alexdebrie.com/posts/lambda-custom-authorizers/
// http://www.goingserverless.com/blog/api-gateway-authorization-and-policy-caching
// https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-lambda-authorizer-input.html
// https://medium.com/tomincode/using-custom-authorizer-context-with-lambda-proxy-integration-1f6eeabb5e4f

const https    = require('https');
const jwk      = require('jsonwebtoken');
const jwkToPem = require('jwk-to-pem');

// For Auth0:       https://<project>.auth0.com/
// refer to:        http://bit.ly/2hoeRXk
// For AWS Cognito: https://cognito-idp.<region>.amazonaws.com/<user pool id>/
// refer to:        http://amzn.to/2fo77UI

const region = process.env.CognitoUserPoolRegion;
const userpool_id = process.env.CognitoUserPoolID;
// const app_client_id = process.env.CognitoUserPoolAppClientID;
const iss = `https://cognito-idp.${region}.amazonaws.com/${userpool_id}`;
const keys_url = `https://cognito-idp.${region}.amazonaws.com/${userpool_id}/.well-known/jwks.json`;


// Reusable Authorizer function, set on `authorizer` field in serverless.yml
module.exports.handler = (event, context, callback) => {
    console.log('Auth function invoked');
    if (event.authorizationToken) {
        const token = event.authorizationToken; //.substring(7); // Remove 'bearer ' from token:
        // Make a request to the iss + .well-known/jwks.json URL:
        https.get(keys_url, (response) => {
            if (response.statusCode == 200) {
                response.on('data', (body) => {
                    const keys = JSON.parse(body.toString());
                    // Based on the JSON of `jwks` create a Pem:
                    const k = keys.keys[0];
                    const jwkArray = {
                        kty: k.kty,
                        n: k.n,
                        e: k.e,
                    };
                    const pem = jwkToPem(jwkArray);
                    // Verify the token:
                    jwk.verify(token, pem, { issuer: iss }, (err, decoded) => {
                        if (err) {
                            console.log('Unauthorized user:', err.message);
                            callback('Unauthorized');
                        } else {
                            const policyDoc = generatePolicy(decoded.sub, 'Allow', '*'); // event.methodArn);
                            policyDoc.context = { ...decoded }; // attach context
                            callback(null, policyDoc);
                        }
                    });
                });
                response.on('error', (err) => {
                    console.error('Unable to download JWKS document fror token validation!', keys_url, err);
                    callback('Unauthorized');
                });
            } else {
                console.error('Unable to download JWKS document fror token validation!', keys_url, response);
                callback('Unauthorized');
            }
        });
    } else {
        console.log('No authorizationToken found in the header.');
        callback('Unauthorized');
    }
};

// Generate policy to allow this user on this API:
const generatePolicy = (principalId, effect, resource) => {
    const authResponse = {};
    authResponse.principalId = principalId;
    if (effect && resource) {
        const policyDocument = {
            Version: '2012-10-17',
            Statement: [{
                Action: 'execute-api:Invoke',
                Effect: effect,
                Resource: resource,
            }]
        };
        authResponse.policyDocument = policyDocument;
    }
    return authResponse;
};