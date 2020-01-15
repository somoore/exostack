'use strict';
const uuid = require('uuid/v4');
const {
  ok,
  badRequest,
  fail
} = require('./response');

const {
  doc: docClient,
  raw: dynamodb,
  conv: converter
} = require('./ddbClient')();

const TenantsTableInfo = {
  TableName: process.env.TenantsDDBTableName,
  HashKey: 'tenantId',
}

const CloudsTableInfo = {
  TableName: process.env.CloudsDDBTableName,
  HashKey: 'tenantId',
  RangeKey: 'accountId'
}

const TenantsController = require('./tenants');
const tenantsController = new TenantsController();

module.exports.handler = async (event, context) => {
  // console.log(event);
  try {
    const registrationEventBody = (event && event.body && JSON.parse(event.body)) || {};
    
    switch (event.resource) {
      
      // New tenant registration step
      case '/registration/tenant':
        return await saveTenant(registrationEventBody);
      
      // New cloud registration step
      case '/registration/connectclouds':
      case '/registration/connectclouds/auth':
        // parse the event body and check if tenantId is explicitly provided
        let { tenantId } = registrationEventBody;
        if (!tenantId) {
          // if not provided, parse the tenantId from the authorizer claims
          let tenantValid, tenantMessage;
          ({ tenantId, tenantValid, tenantMessage } = await tenantsController.validateTenant(event));
          if (!tenantValid) {
            return badRequest({message: tenantMessage});
          }
          registrationEventBody.tenantId = tenantId;
        }
        const onlyTestConnection = event && event.queryStringParameters && event.queryStringParameters['test'] === 'true';
        const editingConnection = event && event.resource === '/registration/connectclouds/auth' && event.queryStringParameters && event.queryStringParameters['mode'] === 'editCloud';
        return await saveCloud(registrationEventBody, onlyTestConnection, editingConnection);

      case '/registration/cancel':
        return await cancelRegistration(registrationEventBody);

      default:
        return badRequest(`Invalid resource requested.`);
    }

  } catch (e) {
    console.error(e);
    return fail(e);
  }
}

/**
 * Save the company info
 * @param {Object} registrationEvent Registration event body
 */
async function saveTenant(registrationEvent) {
  const tenantId = registrationEvent['tenantId'] || uuid();
  const registrationType = registrationEvent['registrationType'] || 'company';
  const registrationInfo = Object.assign(registrationEvent, {
    tenantId,
    registrationType,
    createdAt: new Date().toISOString(),
    tenantStatus: 'ACTIVE'
  });
  const newTenant = await docClient.put({
    TableName: TenantsTableInfo.TableName,
    Item: registrationInfo
  }).promise();
  return ok({
    tenantId
  });
}

/**
 * Tests and/or persists the cloud connection info to database after validation.
*  @param {Object} registrationEventBody cloud info parsed from the event body
 * @param {boolean} onlyTestConnection flag to indicate if only test (true) or save (false)
 * @param {boolean} editingConnection flag to indicate if editing an existing connection (true) or saving a new one (false)
 */
async function saveCloud(registrationEventBody, onlyTestConnection, editingConnection) {
  let {
    tenantId,
    cloudName,
    accountId,
    externalId,
    roleARN
  } = registrationEventBody;
  console.log('saveCloud', {tenantId, cloudName, accountId, externalId, roleARN}, onlyTestConnection, editingConnection);

  if (!tenantId || !accountId || !cloudName || !externalId || !roleARN) {
    return badRequest(`Required parameters for cloud connection not provided.`, 
      tenantId, cloudName, accountId, externalId, roleARN);
  }
  // check for existence of accountId + tenantId
  const accountRecord = await queryCloud(tenantId, accountId);
  const accountExists = accountRecord && accountRecord.Count !== 0;
  
  if (!editingConnection && accountExists) { 
    console.error(`// account being created already exists`);
    return {
      connectionValid: false,
      message: `AccountId ${accountId} has already been saved for this tenant.`
    };
  } else if (editingConnection && !accountExists) { 
    console.error(`// account being edited does not actually exist.`);
    return {
      connectionValid: false,
      message: `AccountId ${accountId} does not exist for this tenant.`
    };
  }
    
  // perform a connectivity test of the proposed connection
  const { connectionValid, message } = await testCloudConnection({ accountId, externalId, roleARN });
  
  if (onlyTestConnection || !connectionValid) {
    return ok({connectionValid, message});
  }

  const nowTimestamp = new Date().toISOString();
  const createdAt = (editingConnection ? accountRecord.Items[0].createdAt : nowTimestamp);
  let cloudsInfo = Object.assign(registrationEventBody,
    {
      tenantId,
      createdAt
    },
    editingConnection && { editedAt: nowTimestamp }
  );
  const newCloud = await docClient.put({
    TableName: CloudsTableInfo.TableName,
    Item: cloudsInfo
  }).promise();

  return ok({
    connectionValid,
    message,
    tenantId,
    accountId
  });
}

/**
 * Attempts to connect to the target tenant cloud account 
 * @param {accountId, externalId, roleARN} param0 cloud inf paraeters
 */
async function testCloudConnection({ accountId, externalId, roleARN }) {
  const cloud = {
    AccountId : accountId,    //unused
    ExternalId: externalId,
    RoleARN   : roleARN
  };
  console.log('testing cloud connection...', cloud);
  try {
     // test connectivity
    const Ec2ClientManager = require('./ec2Client');
    const ec2Mgr = new Ec2ClientManager();
    const ec2Client = await ec2Mgr.getEc2Client({cloud, region:'us-east-1', service: 'EC2'});
    if (typeof ec2Client === 'undefined') {
      return {
        connectionValid: false,
        message: `Unable to establish a connection with the Account ${accountId}.`
      };
    } else {
      return {
        connectionValid: true,
        message: `Connection looks valid.`
      };
    }
  } catch (err) {
    console.error(`Error in testing the Cloud connection`, err);
    return {
      connectionValid: false,
      message: err && err.message
    };
  }
}

/**
 * Query the database for a given tenant and account
 * @param {string} tenantId Tenant
 * @param {string} accountId AWS Account ID
 */
async function queryCloud(tenantId, accountId) {
  return await docClient.query({
    TableName: CloudsTableInfo.TableName,
    KeyConditionExpression: 'tenantId = :t AND accountId = :a',
    ExpressionAttributeValues: {
      ':t': tenantId,
      ':a': accountId
    }
  }).promise();
}

/**
 * Cleans up the saved info when user cancels out of the registration process.
 * // TODO: remove any user account entries from Cognito
 * @param {Object} registrationEventBody parsed event body
 */
async function cancelRegistration(registrationEventBody) {
  const {
    tenantId
  } = registrationEventBody;
  console.log(tenantId);
  if (!tenantId) {
    return badRequest(`Required parameters tenantId not provided.`);
  }
  // delete Tenant record
  await docClient.delete({
    TableName: TenantsTableInfo.TableName,
    Key: {
      'tenantId': tenantId
    }
  }).promise();
  // TODO: delete all users associated with a tenantId
  // GSI -> scan by tenantId -> BATCH delete from Table

  return ok({
    tenantId, 
    status: 'canceled'
  });
}