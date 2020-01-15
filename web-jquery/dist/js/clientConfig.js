export const REFRESH_INTERVAL_MINUTES = 5;
export const COGNITO_USERPOOL_ENABLED = true;
export const MSTSC_SERVICE_ENDPOINT = ''; #if using mstsc input endpoint url here

export const COGNITO_USERPOOL_ID = 'Input_Cognito_Userpool_here';
export const COGNITO_USERPOOL_APPCLIENT_ID = 'Input_Cognito_Userpool_AppclientID_here';

export const PubCloudAccountType = 'public';
export const GovCloudAccountType = 'gov-cloud';

const CloudAccountConfigs = [
    {
        accountType: PubCloudAccountType,
        display: 'AWS',
        default: true,

        REGION: 'us-east-1',
        API_BASE_URL: 'https://fdfsdfvcc.execute-api.us-east-1.amazonaws.com/', #specific to public cloud/commercial region
        HOSTING_AWS_ACCOUNT_ID: 'Input AWS Account ID', #specific to public cloud/commercial region

        features: {
            EC2Instances: true,
            WorkSpaces: true,
            Workflows: {
                EC2: true,
                WorkSpaces: true,
                ShowPricing: true,
                ManualApproval: true
            }
        }
    }, 
    {
        accountType: GovCloudAccountType,
        display: 'GovCloud',
        default: false,

        REGION: 'us-gov-east-1',
        API_BASE_URL: 'https://f1fdfdr44.execute-api.us-gov-east-1.amazonaws.com/gov1', #specific to GovCloud region
        HOSTING_AWS_ACCOUNT_ID: 'Input AWS GovCloud Acct ID', #specific to GovCloud region

        features: {
            EC2Instances: true,
            WorkSpaces: false,
            Workflows: {
                EC2: true,
                WorkSpaces: false,
                ShowPricing: false,
                ManualApproval: false
            }
        }
    }
];

export function getAccountTypes() {
    return CloudAccountConfigs.map(c => { 
        return { accountType: c.accountType, display: c.display, apiBaseURL: c.API_BASE_URL }; 
    });
}

function getDefaultConfig() {
    const defaultConfig = CloudAccountConfigs.find(c => c.default);
    return defaultConfig; // && defaultConfig.config;
}

function isGovCloud(accountType) {
    return (accountType === GovCloudAccountType);
}

export function getCloudAccountConfig(accountType) {
    if (accountType) {
        const accountTypeConfig = CloudAccountConfigs.find(c => c.accountType === accountType);
        return accountTypeConfig; // && accountTypeConfig.config;
    }
    return getDefaultConfig();
}

export function getAccountTypeDisplay(accountType) {
    return getCloudAccountConfig(accountType).display;
}

export function getApiBaseURL(accountType) {
    return getCloudAccountConfig(accountType).API_BASE_URL;
}

export function getHostingAccount(accountType) {
    return getCloudAccountConfig(accountType).HOSTING_AWS_ACCOUNT_ID;
}

export function getFeatures(accountType) {
    return getCloudAccountConfig(accountType).features;
}


export function getCloudFormationURL(externalID, connectionName, accountType) {
    // https://aws.amazon.com/blogs/apn/new-aws-cloudformation-stack-quick-create-links-further-simplify-customer-onboarding/
    const rolePrefix = 'ExostackCrossAccountRole';
    const stackName = `${rolePrefix}-${connectionName}-${new Date().toISOString()}`.replace(/[^0-9a-zA-Z\-]/g, '').substring(0, 250);
    
    const cfnRegion        = getCloudFormationRegion(accountType);
    const domain           = getDomain(accountType);
    const templateURL      = getCloudFormationTemplateURL(accountType);
    const hostingAccountId = getHostingAccount(accountType);

    const cloudFormationURL = `https://console.${domain}/cloudformation/home?region=${cfnRegion}#/stacks/create/review?templateURL=${templateURL}&stackName=${stackName}&param_TrustedAccount=${hostingAccountId}&param_ExternalId=${externalID}`;
    return cloudFormationURL;
}

function getCloudFormationTemplateURL(accountType) {
    return isGovCloud(accountType)
        ? 'https://s3.amazonaws.com/exostack-cross-account-role-template/wizard-govcloud.yml' #input S3 template URL specific to GovCloud region
        : 'https://s3.amazonaws.com/exostack-cross-account-role-template/wizard.yml'; #input s3 template URL specific to public region
}

function getCloudFormationRegion(accountType) {
    return getCloudAccountConfig(accountType).REGION;
}

function getDomain(accountType) {
    return isGovCloud(accountType) 
        ? 'amazonaws-us-gov.com' 
        : 'aws.amazon.com';
}

export function getRoleARNPrefix(accountId, accountType = PubCloudAccountType) {
    return isGovCloud(accountType) 
        ? `arn:aws-us-gov:iam::${accountId}:role/`
        : `arn:aws:iam::${accountId}:role/`;
}

export function getRoleConsolePath(accountId, roleARN, accountType) {
    const splitRoleARN = roleARN.split('/');
    const roleName = splitRoleARN[splitRoleARN.length - 1];
    const domain = getDomain(accountType); 
    return {
        roleName,
        consolePath: `https://console.${domain}/iam/home?#/roles/${roleName}`
    };
}

//serialize data function
export function objectifyForm(form) {
    const formArray = form.serializeArray();
    const returnArray = {};
    for (var i = 0; i < formArray.length; i++) {
        returnArray[formArray[i]['name']] = formArray[i]['value'];
    }
    return returnArray;
}

export function uuidv4() {
    // https://stackoverflow.com/questions/105034/create-guid-uuid-in-javascript
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0,
            v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

export function alert(message, completeCallback
        , actionButtonCallback = { buttonText: '', onClick: () => {} }
        , duration = 4000, clear = false) {
    try {
        
        if (clear) {
            M.Toast.dismissAll();
        }
        if(actionButtonCallback && actionButtonCallback.buttonText) {

        }
        M.toast({html: message, completeCallback, displayLength: duration});
        // console.log(message);
        // window.alert(message);
    } catch (e) {
        // suppress the materialize css error
    }
}

export const rolePolicy = ``;
// #  This template creates a Cross-Account-Role that will grant the Self-Service Portal permissions to manage your account.
// CrossAccountRole:
//     Properties:
//     AssumeRolePolicyDocument:
//         Statement:
//         - Action: 'sts:AssumeRole'
//         Effect: Allow
//         Principal:
//             AWS: !Sub arn:aws:iam::${HOSTING_AWS_ACCOUNT_ID}:root
//         Condition:
//             StringEquals:
//             sts:ExternalId: !Ref ExternalId
//         Sid: ''
//         Version: '2012-10-17'
//     Path: "/"
//     Policies:
//     - PolicyDocument:
//         Statement:
//         - Action:
//             - "ec2:AuthorizeSecurityGroupIngress"
//             - "ec2:RevokeSecurityGroupIngress"
//             - "ec2:DescribeInstances"
//             - "ec2:DescribeSecurityGroups"
//             - "ec2:CreateSecurityGroup"
//             - "ec2:CreateTags"
//             - "ec2:DescribeInstanceAttribute"
//             - "ec2:ModifyInstanceAttribute"
//             - "ec2:StartInstances"
//             - "ec2:StopInstances"
//             - "ec2:RebootInstances"
//             - "ec2:DescribeRegions"
//             - "ec2:GetConsoleOutput"
//             - "ec2:GetConsoleScreenshot"
//             - "s3:*"
//             Effect: Allow
//             Resource: "*"
//         Version: '2012-10-17'
//         PolicyName: SelfServicePortalCloudAccess
//     Type: 'AWS::IAM::Role'`;