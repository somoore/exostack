 [![Gitpod Ready-to-Code](https://img.shields.io/badge/Gitpod-Ready--to--Code-blue?logo=gitpod)](https://gitpod.io/#https://github.com/somoore/exostack) 

![enter image description here](https://exostack-core-images.s3.amazonaws.com/exo-logo.png)
# exostack core | Deployment Guide

**Features**
- Open Source, Serverless, deploy in your own AWS account(s)
- Multi-Account, Multi-Region support including GovCloud
- Manage running state of EC2 & Workspaces 
- Admins | Create Self-Service workflows for your team - pre-approve resource creation; or add guardrails via approval chain
- End-Users | Utilize Self-Service workflows (both pre-approved & approval chains) to create EC2 & Workspaces
- EC2 leasing (stop, reboot, terminate at specific interval)
- Dynamic EC2 Security Group updates for Remote Access
- Isolate UI access to one or more EC2 & or Workspaces based on tag/policies (ABAC) for one or more users/clients without AWS Console or CLI access
- Support for virtual MFA (Authy, Google Auth)


**Exostack Core Architecture** 
![enter image description here](https://exostack-core-images.s3.amazonaws.com/Exostack-Arch.png)


**Prerequisites** 
- git clone  https://github.com/somoore/exostack.git
-  Access to the AWS Console & CLI for any Account & Region you wish to deploy (including GovCloud)
- Ensure [Node.js LTS](https://nodejs.org/en/download/) (8.x or higher) is installed on the deployment workstation
- Install the [Serverless Framework](https://serverless.com/framework/docs/getting-started/) globally on the deployment workstation
`npm i -g serverless`

# Back-End Deployment | AWS (Public)
1. Create a S3 deployment bucket in the Public account
this is what serverless framework will use to store the CloudFormation templates that it creates.

2. In S3 Console, Create a new bucket
3. Provide a unique name e.g. **exostack-api-deployment-bucket** in **US-East-1** region
4. Proceed with the defaults and create the bucket.
5. Alternatively, use the following on the AWS CLI provided with Public credentials
`aws s3api create-bucket --bucket exostack-api-deployment-bucket --region us-east-1 --acl private`

  **Update environment stage config files**
1. Change into the **/api/envs** directory. It should have 2 files prod1.yml and gov1.yml
2. You may choose to rename the stage name. In such case, substitute prod1 or gov1 with the renamed stage names in the commands below.
3. In case you need to use credentials mapped to saved AWS profiles, update the profile name in the profile key.  
e.g. **profile: 544294691318_AdministratorAccess**

# Deploy Cognito | AWS (Public)
1. Provide command-line credentials for the Public hosting account
2. Change into the **api/resources/** directory
3. Run the following command -
`sls deploy -v --stage _prod1_`

- Upon completion, make a **note** of the CloudFormation stack Outputs, as you will need this info later:
![enter image description here](https://exostack-core-images.s3.amazonaws.com/stackoutput-1.png)

**Update the services serverless.yml files**

4. Open the **api/services/serverless.yml** file and update the following settings under the:
 **custom > env** section with your CognitoUserPoolID:
e.g.: **CognitoUserPoolID: _us-east-1_ZSsnQcdWiq_**

Also update the **EmailSenderAddress** to a verified SES email address in the target Public account.
e.g.: **EmailSenderAddress: _noreply@domain.com_**

# Deploy Services Stack | AWS (Public)
1. On the command line, change into the **/api/services** directory
2. Install all the required dependencies using the command -
`npm install`

3. Run the following command:
`sls deploy -v --stage _prod1_`

- This will kick-off the deployment of all the DynamoDB tables, Lambda functions and API Gateway resources in the Public account.
- Upon completion, make a note of the ServiceEndpoint from the Stack Outputs:
**ServiceEndpoint: https://s7kdfkds7na.execute-api.us-east-1.amazonaws.com/prod1**

# Back-End Deployment - AWS (GovCloud)
**Set up GovCloud user credentials (Optional)**
1. Create a deployment user in the GovCloud account having AdministratorAccess permissions
2. Configure a new profile e.g. **exostack-govcloud-sandbox** using the AWS CLI
3. Update the **profile** key in the **gov1.yml** config file
e.g.: **profile: exostack-govcloud-sandbox**

**Create a new deployment bucket in the GovCloud account**

4. Provide a unique name e.g. **exostack-api-deployment-bucket-gov** in Gov region

    aws s3api create-bucket --bucket exostack-api-deployment-bucket-gov --region us-gov-east-1 --acl private _--profile exostack-govcloud-sandbox_

5. Update the **deploymentBucket** key in the **gov1.yml** config file
e.g.: **deploymentBucket: exostack-api-deployment-bucket-gov**

# Deploy Services Stack | AWS (GovCloud)
1. Open a new command prompt and change into the **/api/services** directory.
2. Provide credentials for the GovCloud account - Or - set up a new AWS CLI profile and update the name under the profile key in the gov1.yml config file
e.g.: **profile: exostack-govcloud-sandbox**

3. Run the following command
`sls deploy -v --stage _gov1_`

- This will kick-off the deployment of all the DynamoDB tables, Lambda functions and API Gateway resources.
- Upon completion, make a note of the ServiceEndpoint from the Stack Outputs -
e.g.: **ServiceEndpoint: https://jmmegv8h17.execute-api.us-gov-east-1.amazonaws.com/gov1**

**Update the MFA configuration settings for the Cognito User Pool (Public Account)**
- These settings are not correctly supported through CloudFormation or Serverless framework and need to be updated in the AWS console.

4. **Update MFA configuration**:
- Enable MFA : **Optional**
- 2nd Factors : **Time-based One-time password**
- Attributes to verify : **Email**
- Save changes

![enter image description here](https://exostack-core-images.s3.amazonaws.com/cog_user_pool1.png)

5. Under the Triggers section, update the **Post confirmation** trigger Lambda function to **exostack-backend-_prod1_-userConfirmationTrigger** and **Save** changes.

![enter image description here](https://exostack-core-images.s3.amazonaws.com/cog_user_pool2.png)

# Front-End Web Deploy | AWS (Public)

1. Create a new S3 bucket in the Public account for deploying the website
`aws s3api create-bucket --bucket exostack-website-prod1 --region us-east-1 --acl public-read`
2. In the file **web-jquery/serverless.yml** update the bucketName configuration setting on line 13
e.g.: **bucketName: exostack-website-prod1**

3. Update the following settings in the code file - **web-jquery/dist/js/clientConfig.js**
- Line 5: **COGNITO_USERPOOL_ID  :** Cognito User Pool ID (obtain from output given above in Deploy Cognito #3)
- Line 6: **COGNITO_USERPOOL_APPCLIENT_ID:** Cognito App Client ID (obtain from output given above in Deploy Cognito #3)
- Lines 17 - 19: *Public Cloud* hosting account info
-- **REGION:** us-east-1 (or as per deployment)
-- **API_BASE_URL:**  ServiceEndpoint from the step F.
-- **HOSTING_AWS_ACCOUNT_ID:** AWS Account ID for the Public Hosting
- Lines 37 - 39: *GovCloud* hosting account info
-- **REGION:** us-gov-east-1 (or as per deployment)
-- **API_BASE_URL:**  ServiceEndpoint from the step H.
-- **HOSTING_AWS_ACCOUNT_ID:** AWS Account ID for the GovCloud account

![enter image description here](https://exostack-core-images.s3.amazonaws.com/clientConfig-js.png)

**(Optional)** Setup an S3 bucket for CrossAccountRole CloudFormation templates **wizard.yml** files
1. Create another new S3 bucket for hosting the templates
2. Upload the **wizard.yml** and **wizard-govcloud.yml** files from the **templates** folder
3. Ensure the uploaded files are marked as Public in S3
4. Copy the URLs for both the files and update them

- Update the S3 template URLs in **web-jquery/dist/js/clientConfig.js** on lines 110-111:
![enter image description here](https://exostack-core-images.s3.amazonaws.com/update-s3-temp.png)

5. Install the serverless-finch plugin by running the below command from the **web-jquery** folder
`npm install -D serverless-finch`

6. Upload all files from the **dist** folder to the S3 bucket by running the following command from the command line -
7. Change into the **web-jquery** directory and run -
`serverless client deploy`
8. Confirm the upload and bucket configuration updates.
- Upon completion, navigate to the S3 website URL (see endpoint below) for a quick confirmation:
![enter image description here](https://exostack-core-images.s3.amazonaws.com/sls-client-deploy.png)

# CloudFront Setup
 - From the AWS Console in the Public Account, navigate to the CloudFront console and Create new Web distribution with the following settings:
 - Origin Settings - choose the S3 bucket used for the website hosting -
![enter image description here](https://exostack-core-images.s3.amazonaws.com/create-distribution.png)
![enter image description here](https://exostack-core-images.s3.amazonaws.com/default-cache.png)
![enter image description here](https://exostack-core-images.s3.amazonaws.com/dist-settings.png)

**(Optional) ACM Certificates**
 - Request and validate ACM certificates in US-East-1 region of the
   Public Hosting account with the appropriate domain name applicable.

**(Optional) Route 53**
 - Set up DNS entry for mapping the CloudFront distribution to a custom
   domain name record.

## Acknowledgments
- [eeg3/workspaces-portal](https://github.com/eeg3/workspaces-portal) | 
- [marekq/aws-lambda-firewall](https://github.com/marekq/aws-lambda-firewall)
- [Serverless Stack](https://serverless-stack.com/)
- [APN Blog](https://aws.amazon.com/blogs/apn/new-aws-cloudformation-stack-quick-create-links-further-simplify-customer-onboarding/)

##### License | This project is licensed under the [2-Clause BSD License](https://opensource.org/licenses/BSD-2-Clause).

