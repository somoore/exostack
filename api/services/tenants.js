'use strict';

const {
  doc: docClient,
  raw: dynamodb,
  conv: converter
} = require('./ddbClient')();

const TenantsTableInfo = {
  TableName: process.env.TenantsDDBTableName,
  HashKey: 'tenantId'
}

module.exports = class TenantsController {
  // init({ tenantId }) {
  //     this.TenantId = tenantId;
  // }
  async getTenants() { }

  async validateTenant(event) {
    // console.log(JSON.stringify(event, null, 2));
    let tenantValid = true;
    let tenantMessage;
    const tenantId = event.requestContext.authorizer["custom:tenantId"];
    // console.log('TENANTID', tenantId);
    if (!tenantId) {
      tenantMessage = 'Invalid or missing tenantId provided.';
      console.error(tenantMessage, tenantId);
      tenantValid = false;
    } else {
      tenantValid = true; //TODO: make tenant data accessible to non-public accounts
    }
    // const { tenantStatus, registrationType, createdAt } = await this.getTenantRecord(tenantId);
    // if (tenantStatus !== 'ACTIVE') {
    //   tenantMessage = 'Unauthorized tenant requested. (TENANT INACTIVE)';
    //   console.error(tenantMessage, tenantId, tenantStatus);
    //   tenantValid = false;
    // }
    return { 
      tenantId, tenantStatus: 'ACTIVE', tenantValid, 
      tenantMessage: null, registrationType: null, createdAt: null 
    };
  }


  async getTenantRecord(tenantId) {
    try {
      const tenantRecord = await docClient.get({
        TableName: TenantsTableInfo.TableName,
        Key: {
          [TenantsTableInfo.HashKey]: tenantId
        }
      }).promise();
      const {
        tenantStatus,
        registrationType,
        createdAt,
      } = tenantRecord.Item || {};

      console.log('getTenantRecord', tenantId, tenantStatus, registrationType, createdAt);

      return {
        tenantId,
        tenantStatus,
        registrationType,
        createdAt
      };
    } catch (e) {
      console.error('getTenantRecord', e);
      throw e;
    }
  }
}