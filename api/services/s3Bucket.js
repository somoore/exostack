'use strict';

const {
  TagNameS3Bucket = 'firewall',
} = process.env;

const Ec2ClientManager = require('./ec2Client');
const ec2Mgr = new Ec2ClientManager();

module.exports = class S3BucketController {
  
  async init({cloud, region}) {
    this.s3 = await ec2Mgr.getEc2Client({cloud, region, service:'S3'});
  }

  async getBuckets() {
    try{
      return [{bucketName: 'Temporary disabled', createdAt:new Date().toISOString()}];
      
      const bucketsResponse = await this.s3.listBuckets().promise();
      const buckets = bucketsResponse.Buckets
        .filter(b => b.Name.includes(TagNameS3Bucket))
        .map(b => { return { bucketName:b.Name, createdAt:b.CreationDate }; })
      return buckets;

    } catch(e) {
      console.error(e.message);
      throw e;
    }
  }
}