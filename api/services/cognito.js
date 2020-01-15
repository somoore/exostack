'use strict';

const {
    doc: docClient,
    raw: dynamodb,
    conv: converter
} = require('./ddbClient')();

const UsersTableInfo = {
    TableName: process.env.UsersDDBTableName,
    HashKey: 'username',
}

module.exports.userConfirmationTrigger = async (event, context, callback) => {
    try {

        console.log(event);
        /*
        { 
            'custom:tenantId': '792d78f1-528e-49ac-b8a6-6a748cfe0e8f',
            sub: '543a81c7-ed47-4907-ac8d-3b3092a829c0',
            'custom:userTags': '[{"Name":"tag:Team","Values":["DevOps"]},{"Name":"tag:Project","Values":["Portal"]}]',
            'cognito:email_alias': 'lalitr@gmail.com',
            'cognito:user_status': 'CONFIRMED',
            email_verified: 'true',
            given_name: 'Lalit',
            family_name: 'R',
            email: 'lalitr@gmail.com',
            'custom:appRole': 'Admin' }
        */
        const userAttribs = event.request.userAttributes;
        const userEmail   = userAttribs['email'];
        const userRole    = userAttribs['custom:appRole'];
        const userTags    = userAttribs['custom:userTags'];
        const tenantID    = userAttribs['custom:tenantId'];
        const given_name  = userAttribs['given_name'];
        const family_name = userAttribs['family_name'];

        const cognitoUser = //Object.assign(userAttribs,
        {
            username: userEmail,
            source: 'COGNITO',
            createdAt: new Date().toISOString(),
            enabled: true,
            isAdmin: (userRole === 'Admin'),
            tenantID,
            userTags: JSON.parse(userTags),
            // userRole,
            // given_name,
            // family_name,
        };
        
        const newUser = await docClient.put({
            TableName: UsersTableInfo.TableName,
            Item: cognitoUser
        }).promise();
        
        console.log(`Confirmed Cognito user [${userEmail}] successfully added to DynamoDB Users Table`);
        
        return event;
    } catch(e) {
        console.error(`ERROR adding confirmed Cognito user to DynamoDB Users Table`, e);
        return false;
    }

    // if (event.request.userAttributes.email) {
    //         sendEmail(event.request.userAttributes.email, "Congratulations " + event.userName + ", you have been confirmed: ", function(status) {

    //         // Return to Amazon Cognito
    //         callback(null, event);
    //     });
    // } else {
    //     // Nothing to do, the user's email ID is unknown
    //     callback(null, event);
    // }
};

// function sendEmail(to, body, completedCallback) {
//     var eParams = {
//         Destination: {
//             ToAddresses: [to]
//         },
//         Message: {
//             Body: {
//                 Text: {
//                     Data: body
//                 }
//             },
//             Subject: {
//                 Data: "Cognito Identity Provider registration completed"
//             }
//         },

//         // Replace source_email with your SES validated email address
//         Source: "<source_email>"
//     };

//     var email = ses.sendEmail(eParams, function(err, data){
//         if (err) {
//             console.log(err);
//         } else {
//             console.log("===EMAIL SENT===");
//         }
//         completedCallback('Email sent');
//     });
//     console.log("EMAIL CODE END");
// };
