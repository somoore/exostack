import {
    COGNITO_USERPOOL_ID,
    COGNITO_USERPOOL_APPCLIENT_ID,
    uuidv4
} from './clientConfig.js';

const cookieOptions = { domain: ".exostack.com" };
const poolData = {
    UserPoolId: COGNITO_USERPOOL_ID,
    ClientId: COGNITO_USERPOOL_APPCLIENT_ID,
    // Storage: new AmazonCognitoIdentity.CookieStorage(cookieOptions) //BREAKING change!
};
const userPool = new AmazonCognitoIdentity.CognitoUserPool(poolData);

/**
 * Helper function to wrap a user email into a CognitoUser object
 * @param {string} userEmail username identifier (email)
 */
function getCognitoUser(userEmail) {
    const userData = {
        Username: userEmail,
        Pool: userPool,
        // Storage: new AmazonCognitoIdentity.CookieStorage(cookieOptions) //BREAKING change!
    };
    const cognitoUser = new AmazonCognitoIdentity.CognitoUser(userData);
    return cognitoUser;
}

export async function userSignUp({userEmail, password, firstName, lastName, appRole, tenantId, userTags}) {
    
    // console.log(userEmail, password, firstName, lastName, appRole, tenantId);
    // Initialize the Amazon Cognito credentials provider
    // AWS.config.region = 'us-east-1'; // Region
    // AWS.config.credentials = new AWS.CognitoIdentityCredentials({
    //     IdentityPoolId: 'us-east-1:15e76861-3d6c-4289-ad81-5221cd2b49be',
    // });

    const attributeList = [{
        Name: 'given_name',
        Value: firstName
    }, {
        Name: 'family_name',
        Value: lastName
    }, {
        Name: 'custom:appRole',
        Value: appRole
    }, {
        Name: 'custom:tenantId',
        Value: tenantId
    }, {
        Name: 'custom:userTags',
        Value: JSON.stringify(userTags)
    }].map(a => new AmazonCognitoIdentity.CognitoUserAttribute(a));

    return new Promise((resolve, reject) => {
        userPool.signUp(userEmail, password, attributeList, null, function (err, result) {
            if (err) {
                return reject(err);
            }
            const cognitoUser = result.user;
            console.log('New signed-up user is ' , cognitoUser);
            console.log('New signed-up user name is ' + cognitoUser.getUsername());
            return resolve({firstName, userEmail});
        });
    });
}

export async function getCurrentAuthUser() {
    return new Promise((resolve, reject) => {
        const cognitoUser = userPool.getCurrentUser();
        if (cognitoUser) {
            // console.log(cognitoUser);
            cognitoUser.getSession((err, session) => {
                if (err) {
                    console.error('getCurrentAuthUser', err);
                    return reject(err);
                }
                if (session && session.isValid()) {
                    return resolve(cognitoUser);
                } else {
                    return reject('session invalid');
                }
            });
        }
        return reject('no current user');
    });
}

export async function userSignIn(userEmail, password) {
    const authenticationData = {
        Username: userEmail,
        Password: password
    };
    const authenticationDetails = new AmazonCognitoIdentity.AuthenticationDetails(authenticationData);
    const cognitoUser = getCognitoUser(userEmail);
    return new Promise((resolve, reject) => {
        cognitoUser.authenticateUser(authenticationDetails, {
            onSuccess: (authInfo) => {
                console.log(authInfo);
                // cognitoUser.getUserAttributes(function(err, result) {
                //     if (err) {
                //         alert(err.message || JSON.stringify(err));
                //         return;
                //     }
                //     for (let i = 0; i < result.length; i++) {
                //         console.log('attribute ' + result[i].getName() + ' has value ' + result[i].getValue());
                //     }
                // });
                const { appRole, tokenEmail } = getUserInfoFromAuthTokens(authInfo);
                console.assert(userEmail === tokenEmail, 'ALERT: Unexpected mismatch of userEmail !!');
                // setupMfaTOTP(cognitoUser).then(() => {
                    return resolve({userEmail, appRole});
                // });
            },
            onFailure: (err) => {
                return reject(err);
            },

            mfaSetup: (challengeName, challengeParameters) => {
                console.log('Associating TOTP MFA', challengeName, challengeParameters);
                cognitoUser.associateSoftwareToken(this);
            },
 
            associateSecretCode : (secretCode) => {
                var challengeAnswer = prompt('Please input the TOTP secret code.' ,'');
                cognitoUser.verifySoftwareToken(challengeAnswer, 'My TOTP device', this);
            },
 
            selectMFAType : function(challengeName, challengeParameters) {
                var mfaType = prompt('Please select the MFA method.', 'SOFTWARE_TOKEN_MFA'); // valid values for mfaType is "SMS_MFA", "SOFTWARE_TOKEN_MFA" 
                cognitoUser.sendMFASelectionAnswer(mfaType, this);
            },
 
            totpRequired : function(secretCode) {
                // console.log('totpRequired - secretCode', secretCode);
                var challengeAnswer = prompt('Your account is protected using a MFA token.\nPlease enter the TOTP code from your Authenticator app.' ,'');
                if (challengeAnswer && !Number.isNaN(challengeAnswer)) {
                    cognitoUser.sendMFACode(challengeAnswer, this, 'SOFTWARE_TOKEN_MFA');
                }
            },
        });
    });
}

export function getUserInfoFromAuthTokens(authenticatedUserSession) {
    const idToken = authenticatedUserSession.getIdToken(); //.getJwtToken();
    const accessToken = authenticatedUserSession.getAccessToken(); // .getJwtToken();
    // console.log('ACCESS_TOKEN', accessToken);
    // console.log('ID_TOKEN', idToken);
    const appRole = idToken.payload['custom:appRole'];
    const tokenEmail = idToken.payload['email'];
    return { appRole, tokenEmail };
}

export async function setupMfaTOTP(/*cognitoUser*/) {
    console.log('setting up MFA...');
    return new Promise((resolve, reject) => {
        const cognitoUser = userPool.getCurrentUser();
        const userName = cognitoUser.getUsername();
        const issuer = 'Portal';
        cognitoUser.getSession((err, session) => {
            if (err) {
                console.error(err);
                return reject(err.message);
            }
            cognitoUser.associateSoftwareToken({
                onFailure: (err) => {
                    console.error(err);
                    return reject(err);
                },
                associateSecretCode: (secretCode) => {
                    console.log('SECRET CODE: ', secretCode);
                    const otpAuthURL = `otpauth://totp/AWSCognito:${userName}?secret=${secretCode}&issuer=${issuer}`
                    return resolve({secretCode, otpAuthURL});
                }
            })
        });
    });
}

export async function verifyMFAToken(challengeAnswer, deviceFriendlyName = 'Google Auth') {
    return new Promise((resolve, reject) => {
        const cognitoUser = userPool.getCurrentUser();
        const userName = cognitoUser.getUsername();
        const issuer = 'Portal';
        cognitoUser.getSession((err, session) => {
            if (err) {
                console.error(err);
                return reject(err.message);
            }
            cognitoUser.verifySoftwareToken(challengeAnswer, deviceFriendlyName, {
                onSuccess: (session) => {
                    console.log('verifySoftwareToken success, session =', session);
                    changeMFAPreference(cognitoUser, 'enable')
                        .then(mfaPrefChanged => resolve(mfaPrefChanged))
                        .catch(e => {
                            console.error(e);
                            reject(e);
                        });
                },
                onFailure: (err) => {
                    console.error(err);
                    return reject(err);
                }
            });
        });
    });
}

export async function changeMFAPreference(cognitoUser, enableOrDisable = 'enable') {
    const totpMfaSettings = {
        PreferredMfa: enableOrDisable === 'enable',
        Enabled: enableOrDisable === 'enable'
    };
    const smsMfaSettings = {
        PreferredMfa: false,
        Enabled: false
    };
    if (!cognitoUser) {
        cognitoUser = userPool.getCurrentUser();
    }
    return new Promise((resolve, reject) => {
        cognitoUser.getSession( (err, session) => {
            if (err) {
                console.error(err);
                return reject(err.message);
            }
            cognitoUser.setUserMfaPreference(null, totpMfaSettings, function (err, result) {
                if (err) {
                    console.error(err);
                    return reject(err);
                }
                console.log('call result ' + result);
                return resolve(`MFA preference ${enableOrDisable}`);
            });
        });
    });
}

export async function changeMFA(enableOrDisable = 'enable') {
    // const cognitoUser = getCognitoUser(userEmail)
    const cognitoUser = userPool.getCurrentUser();
    return new Promise((resolve, reject) => {
        cognitoUser.getSession( (err, session) => {
            if (err) {
                console.error(err);
                return reject(err.message);
            }
            //TODO: refactor duplication!
            if (enableOrDisable === 'enable') {
                cognitoUser.enableMFA(function (err, result) {
                    if (err) {
                        console.error(err);
                        return reject(err);
                    }
                    console.log('EnableMFA call result: ' + result);
                    changeMFAPreference(cognitoUser, enableOrDisable)
                        .then(mfaPrefChanged => {
                            return resolve(`MFA ${enableOrDisable}`);
                        })
                        .catch(e => {
                            console.error(e);
                            return reject(e);
                        });
                });
            } else if (enableOrDisable === 'disable') {
                cognitoUser.disableMFA(function (err, result) {
                    if (err) {
                        alert(err);
                        return reject(err);
                    }
                    console.log('DisableMFA call result: ' + result);
                    changeMFAPreference(cognitoUser, enableOrDisable)
                        .then(mfaPrefChanged => {
                            return resolve(`MFA ${enableOrDisable}`);
                        })
                        .catch(e => {
                            console.error(e);
                            return reject(e);
                        });
                });
            } else {
                return reject(`Invalid option provided (${enableOrDisable})`);
            }
        });
    });
}

export async function getCognitoUserData() {
    // const cognitoUser = getCognitoUser(userEmail)
    const cognitoUser = userPool.getCurrentUser();
    return new Promise((resolve, reject) => {
        cognitoUser.getSession( (err, session) => {
            if (err) {
                console.error(err);
                return reject(err.message);
            }
            cognitoUser.getUserData((err, userInfo) => {
                if (err) {
                    console.error(err);
                    return reject(err);
                }
                console.log('getUSerData', userInfo);
                return resolve(userInfo);
            });
        });
    });
}

export async function getAuthorizationHeader(userEmail) {
    return new Promise((resolve, reject) => {
        const cognitoUser = userPool.getCurrentUser();
        if (cognitoUser) {
            // console.log(cognitoUser);
            cognitoUser.getSession(function (err, session) {
                if (err) {
                    console.error(`getAuthorizationHeader -> getSession`, err);
                    return reject(err);
                }
                if (session.isValid()) {
                    const idToken = session.getIdToken().getJwtToken();
                    // const accessToken = session.getAccessToken().getJwtToken();
                    // console.log(`session is valid`, session, idToken);
                    return resolve(idToken);
                } else {
                    const refresh_token = session.getRefreshToken();
                    console.log('session is invalid', refresh_token, 'about to refresh...');
                    cognitoUser.refreshSession(refresh_token, (err, session) => {
                        if (err) {
                            console.error(`getAuthorizationHeader -> refreshSession`, err);
                            return reject(err);
                        } else {
                            return resolve(session.getIdToken().getJwtToken());
                        }
                    });
                }
            });
        }
    });
}
    // const cognitoUser = userPool.getCurrentUser();
    // if (cognitoUser) {
    //     // console.log(cognitoUser);
    //     return cognitoUser.getSession(function(err, session) {
    //         if (err) {
    //             console.error(err);
    //         }
    //         if (session && session.isValid()) {
    //             const idToken = session.getIdToken().getJwtToken();
    //             const accessToken = session.getAccessToken().getJwtToken();
    //             // console.log(`session is valid`, idToken, accessToken);
    //             return idToken;
    //             // return accessToken;
    //         } else {
    //             const refresh_token = session.getRefreshToken();
    //             console.log('session is invalid', refresh_token, 'about to refresh...');
    //             cognitoUser.refreshSession(refresh_token, (err, session) => {
    //                 if(err) {
    //                     console.error(err);
    //                     return err;
    //                 } else {
    //                     const idToken = session.getIdToken().getJwtToken();
    //                     console.log(`session has been refreshed!!!`, idToken);
    //                     return idToken;
    //                 }
    //             });
    //         }
    //     });
    // }
// }


export async function confirmUser(userEmail, confirmationCode) {
    const cognitoUser = getCognitoUser(userEmail);
    return new Promise((resolve, reject) => {
        cognitoUser.confirmRegistration(confirmationCode, true, function(err, result) {
            if (err) {
                console.error(err.message || JSON.stringify(err));
                return reject(err);
            } else {
                console.log('call result: ' + result);
                return resolve(result);
            }
        });
    });
}

export async function userSignOut() {
    // try {
        const cognitoUser = await getCurrentAuthUser();
        console.log(cognitoUser);
        return new Promise((resolve, reject) => {
            cognitoUser.globalSignOut({
                onSuccess: (message) => {
                    console.log('SIGNED OUT', message);
                    return resolve(true);
                },
                onFailure: (e) => {
                    // console.error(e);
                    // if (e.code === 'NotAuthorizedException') {
                    //     console.log('already signed out');
                    //     return reject(e);
                    // }
                    return reject(e);
                }
            });
        });
    // } catch (e) {

    // }
    // .catch(_ => );
}

export async function forgotPassword(userEmail) {
    const cognitoUser = getCognitoUser(userEmail);
    return new Promise((resolve, reject) => {
        cognitoUser.forgotPassword({
            onSuccess: function (data) {
                // successfully initiated reset password request
                console.log('CodeDeliveryData from forgotPassword: ' + data);
                return resolve(data);
            },
            onFailure: function(err) {
                console.log(err.message || JSON.stringify(err));
                return reject(err.message);
            },
            // //Optional automatic callback
            // inputVerificationCode: function(data) {
            //     console.log('Code sent to: ' + data);
            //     var code = document.getElementById('code').value;
            //     var newPassword = document.getElementById('new_password').value;
            //     cognitoUser.confirmPassword(verificationCode, newPassword, {
            //         onSuccess() {
            //             console.log('Password confirmed!');
            //         },
            //         onFailure(err) {
            //             console.log('Password not confirmed!');
            //         }
            //     });
            // }
        });
    });
}

export async function updateUserTags(awsTagsFormatString) {
    try {
        const cognitoUser = await getCurrentAuthUser();
        console.log(cognitoUser, awsTagsFormatString);
        return new Promise((resolve, reject) => {
            const attribs = [new AmazonCognitoIdentity.CognitoUserAttribute({ Name: 'custom:userTags', Value: JSON.stringify(awsTagsFormatString) })];
            cognitoUser.updateAttributes(attribs, (err, result) => {
                if (err) {
                    console.error('updateUserAttributes', err);
                    return reject(`Unable to update the user attribute`);
                }
                return resolve(result);
            });
        });
    } catch(err) {
        console.error('updateUserAttributes', err);
        throw err;
    }
}