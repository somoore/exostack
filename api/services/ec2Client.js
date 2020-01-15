const AWS = require('aws-sdk');

module.exports = class Ec2ClientManager {

  constructor() {
    this.sts = new AWS.STS();
  }
  
  async getEc2Client({cloud, region, service = 'EC2'}) {
    try {
      console.log(`getting Service Client for: `, service);
      // if (!this.externalCredentials) { // || this.externalCredentials.Expiration.valueOf() > new Date().valueOf()) {
      this.externalCredentials = await this.getExternalCredentials(cloud);
      // } else {
      //   console.log(`reusing existing credentials!`, JSON.stringify(this.externalCredentials));
      // }

      let serviceInstance;
      const options = {
        credentials: new AWS.Credentials({
          accessKeyId    : this.externalCredentials.AccessKeyId,
          secretAccessKey: this.externalCredentials.SecretAccessKey,
          sessionToken   : this.externalCredentials.SessionToken
        }),
        region: region || process.env.AWS_REGION
      };
      switch (service) {
        case 'EC2': 
          serviceInstance = new AWS.EC2(options);
          break;
        case 'S3':
          serviceInstance = new AWS.S3(options);
          break;
        case 'WorkSpaces':
          serviceInstance = new AWS.WorkSpaces(options);
          // await serviceInstance.makeRequest('test').send(e => console.error('makeRequest', e));
          break;
        case 'WorkDocs':
          serviceInstance = new AWS.WorkDocs(options);
          break;
        case 'Pricing':
          serviceInstance = new AWS.Pricing(options);
          break;
        default:
          throw new Error(`Invalid service name provided: ${service}`);
      }
      // console.log('serviceInstance', !!serviceInstance, 'endpoint', serviceInstance.endpoint);
      return serviceInstance;
    } catch (e) {
      console.error('getEc2Client', e);
    }
  }

  async getExternalCredentials(cloud) {
    try {
      const { AccountId, RoleARN, ExternalId } = cloud;
      console.log(`Getting external credentials for cloud`, AccountId, RoleARN, ExternalId);
      const externalCreds = await this.sts.assumeRole({
        RoleArn        : RoleARN,
        ExternalId     : ExternalId,
        RoleSessionName: `Exostack-Session-${Date.now()}`
      }).promise();

      console.log(`External credentials retrieved successfully!`);
        // externalCreds.Credentials.AccessKeyId,
        // externalCreds.Credentials.SecretAccessKey,
        // externalCreds.Credentials.SessionToken);

      return externalCreds.Credentials;
    } catch (e) {
      console.error('ERROR getting external credentials. Confirm the RoleARN and ExternalID setup in the target AWS account', e.message, JSON.stringify(cloud));
      throw e;
    }
  }

}