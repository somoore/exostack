'use strict';

const {
    doc: docClient,
    raw: dynamodb,
    conv: converter
} = require('./ddbClient')();

const CloudsTableInfo = {
    TableName: process.env.CloudsDDBTableName,
    HashKey: 'tenantId',
    RangeKey: 'accountId'
}

const CloudsDDBTenantIndex = {
    IndexName: process.env.CloudsDDBTenantIndexName,
    HashKey: 'tenantId'
}

module.exports = class CloudsController {

    init({ tenantId }) {
        this.TenantId = tenantId;
    }

    /**
     * Gets a single cloud connection info for a given tenant and accountId
     */
    async getCloud(accountId) {
        console.log(`Looking up cloud info for tenantId:${this.TenantId} and AccountId:${accountId}`);
        const getCloudsRequest = {
            TableName: CloudsTableInfo.TableName,
            ProjectionExpression: 'cloudName, accountId, externalId, roleARN',
            Key: { accountId, tenantId: this.TenantId },
        }
        const cloudRecord = await docClient.get(getCloudsRequest).promise();
        // console.log(``, JSON.stringify(cloudRecord));
        return cloudRecord && cloudRecord.Item && this._mapCloudRecord(cloudRecord.Item);
    }

    /**
     * Gets a list of cloud connection info for a given tenant
     */
    async getClouds() {
        console.log(`Fetching all clouds for tenantId:${this.TenantId}`);
        const queryCloudsRequest = {
            TableName: CloudsTableInfo.TableName,
            IndexName: CloudsDDBTenantIndex.IndexName,
            ProjectionExpression: 'cloudName, accountId, externalId, roleARN, accountType',
            KeyConditionExpression: `tenantId = :tenantId`,
            ExpressionAttributeValues: {
                ':tenantId': this.TenantId
            }
        }
        const cloudRecords = await docClient.query(queryCloudsRequest).promise();
        const clouds = cloudRecords.Items.map(c => this._mapCloudRecord(c));
        console.log(`found ${clouds.length} clouds`, JSON.stringify(clouds));
        return clouds;
    }

    _mapCloudRecord(c) {
        return {
            Name       : c.cloudName,
            AccountId  : c.accountId,
            RoleARN    : c.roleARN,
            ExternalId : c.externalId,
            AccountType: c.accountType
        };
    }

    /**
     * Gets a formatted list for displaying cloud connections for a given tenant
     */
    async getCloudsDisplay() {
        const clouds = await this.getClouds();
        return clouds.map(({ Name, AccountId, ExternalId, RoleARN, AccountType }) => {
            const first4 = AccountId.substring(0, 4);
            const last4 = AccountId.substring(AccountId.length - 4);
            const mask = AccountId.substring(4, AccountId.length - 4).replace(/\d/g, "*");
            return { DisplayName: `${first4}${mask}${last4} (${Name})`, Name,  AccountId, ExternalId, RoleARN, AccountType };
        });
    }

    /**
     * Deletes a single cloud connection based on AWS Account ID
     * @param {string} accountId AWS Account ID associated with the cloud being deleted
     */
    async deleteCloud(accountId) {
        try {
            const clouds = await this.getClouds();
            // if (clouds.length === 1) {
            //     const message = `Sorry, cannot delete the last cloud connection available for this tenant!`;
            //     console.error(message);
            //     return {
            //         message,
            //         deleted: false
            //     };
            // }
            const cloudDeleted = await docClient.delete({
                TableName: CloudsTableInfo.TableName,
                Key: {
                    tenantId: this.TenantId,
                    accountId
                }
            }).promise();
            return {
                message: 'Cloud deleted successfully!',
                deleted: true
            };
        } catch (e) {
            const message = `Oops, An error occurred attempting to delete the cloud connection!`;
            console.error(message, JSON.stringify(e));
            return {
                message,
                deleted: false
            };
        }
    }

}
