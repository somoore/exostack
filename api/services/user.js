'use strict';
const uuid = require('uuid/v4');
const {
  doc: docClient,
  raw: dynamodb,
  conv: converter
} = require('./ddbClient')();

const aws = require('aws-sdk');
const apigwClient = new aws.APIGateway({
  region: process.env.AWS_REGION || process.env.AWS_REGION_DEVTEST,
});

const UsersTableInfo = {
  TableName: process.env.UsersDDBTableName,
  HashKey: 'username',
}

const UsersDDBTenantIndexInfo = {
  TableName: process.env.UsersDDBTableName,
  IndexName: process.env.UsersDDBTenantIndexName,
  HashKey: 'tenantID',
}

const {
  usagePlanId
} = process.env;

async function getUsers(tenantId) {
  console.log('getUsers', tenantId);
  const users = await docClient.query({
    TableName: UsersTableInfo.TableName,
    IndexName: UsersDDBTenantIndexInfo.IndexName,
    KeyConditionExpression: 'tenantID = :t',
    ExpressionAttributeValues: {
      ':t': tenantId
    }
    // ProjectionExpression: ''
  }).promise();
  return users && users.Items && users.Items.map(user => {
    return {
      username: user.username,
      isAdmin : user.isAdmin,
      enabled : user.enabled
    }
  });
}

async function getUserTags(username) {
  console.log('getUserTags', username);
  const userTags = await docClient.get({
    TableName: UsersTableInfo.TableName,
    Key: {
      username
    },
    ProjectionExpression: 'userTags'
  }).promise();
  return userTags && userTags.Item;
}

async function updateUserTags(username, userTags) {
  return await docClient.update({
    TableName: UsersTableInfo.TableName,
    Key: {
      username
    },
    UpdateExpression: 'set userTags = :ut' ,
    ExpressionAttributeValues: {
      ':ut': userTags || '[]'
    }
  }).promise();
}

/**
 * Creates a new API key for a new user 
 * and puts a corresponding entry in the Users table
 * @param {string} username the user name 
 */
async function setupApiKey(username, newUserApiKey = uuid()) {
  if (process.env.IS_OFFLINE === 'true') {
    return {
      username,
      userSecret: newUserApiKey
    };
  }
  // query for an existing key for the user
  const newApiKeyName = `LFW_APIKey-${username}`;
  console.log(`checking for existing API Key for username: ${username} with name: ${newApiKeyName}`);
  const apiKeys = await apigwClient.getApiKeys({
    includeValues: true,
    nameQuery: newApiKeyName,
    limit: 1
  }).promise();

  // if an API key already exists, ensure it is enabled
  if (apiKeys.items && apiKeys.items.length === 1) {
    const existingKey = apiKeys.items[0];
    console.log(`Found existing api key for user!`, existingKey);
    if (!existingKey.enabled) {
      const keyUpdated = await apigwClient.updateApiKey({
        apiKey: existingKey.id,
        patchOperations: [{
          op: 'replace',
          path: '/enabled',
          value: 'true'
        }]
      }).promise();
      console.log(`Updated existing key enabled flag`, keyUpdated);
    }
    return {
      username,
      userSecret: existingKey.value,
      status: `existing key enabled`
    };
  }
  // create a new API key 
  console.log(`Creating a new API key with name: ${newApiKeyName}`);
  const userApiKey = await apigwClient.createApiKey({
    value: newUserApiKey,
    enabled: true,
    name: newApiKeyName,
    description: `API Key for LambdaFirewall user: ${username}`,
  }).promise();
  console.log(`created new API key for username: ${username}`, userApiKey);
  // const allUsagePlans = await apigwClient.getUsagePlans({ }).promise();
  // console.log(`all usage plans`, JSON.stringify(allUsagePlans));
  console.log(`associating new API key with id: ${userApiKey.id} with usage plan ${usagePlanId}`);
  const usagePlanKey = await apigwClient.createUsagePlanKey({
    keyId: userApiKey.id,
    keyType: 'API_KEY',
    usagePlanId: usagePlanId
  }).promise();
  console.log(`usagePlanKey`, usagePlanKey);
  return {
    username,
    userSecret: newUserApiKey,
    status: `created new api key`
  };
}

/**
 * Creates a new user along with their API Key 
 * @param {string} username User name
 * @param {string} newUserApiKey (Optional) API Key to be used for the new user
 */
async function provisionUser(username, newUserApiKey = null, isAdmin = false) {
  const {
    userSecret
  } = await setupApiKey(username, newUserApiKey);
  const newUser = await docClient.put({
    TableName: UsersTableInfo.TableName,
    Item: {
      username,
      apiKey: userSecret,
      enabled: true,
      createdAt: new Date().toISOString(),
      isAdmin
    }
  }).promise();
  return {
    username,
    userSecret
  };
}

/**
 * Fetches a set of user records 
 * @param {Number} limit maximum number of records to return
 */
async function getUsersInfo(limit = 100) {
  const userRecords = await docClient.scan({
    TableName: UsersTableInfo.TableName,
    ProjectionExpression: 'username, apiKey, enabled',
    Limit: limit
  }).promise();
  return userRecords.Items.map(i => {
    return {
      username: i['username'],
      apiKey: i['apiKey'],
      enabled: i['enabled'] ? "true" : "false"
    }
  });
}

/**
 * Authenticates a user's credentials and identifies if user is Admin
 * @param {string} username user name
 * @param {string} userSecret the API key
 */
async function authenticateUser(username, userSecret) {
  const {
    apiKey,
    enabled,
    isAdmin
  } = await getUserRecord(username);

  const authenticated = (userSecret === apiKey && enabled === true);
  console.log(`Authentication result for ${username} @ ${new Date().toUTCString()} - auth:${authenticated} | admin:${isAdmin}`);
  if (authenticated && isAdmin) {
    return {
      authenticated,
      isAdmin
    };
  }
  return {
    authenticated
  };
}

/**
 * Queries the Users table for existence of a record for a given username
 * @param {string} username User name
 */
async function getUserRecord(username) {
  try {
    const userRecord = await docClient.query({
      TableName: UsersTableInfo.TableName,
      KeyConditionExpression: `${UsersTableInfo.HashKey} = :un`,
      ProjectionExpression: 'username, apiKey, enabled, isAdmin, userTags',
      ExpressionAttributeValues: {
        ':un': username,
        // ':ak': userSecret,
        // ':en': true
      }
      // FilterExpression: 'apiKey = :ak AND enabled = :en',
    }).promise();
    const {
      apiKey,
      enabled,
      isAdmin,
      userTags
    } = (userRecord.Items && userRecord.Items.length === 1 && userRecord.Items[0]) || {};

    console.log('getUserRecord', userTags);

    return {
      username,
      apiKey,
      enabled,
      isAdmin,
      userTags
    };
  } catch (e) {
    console.error('getUserRecord', e);
  }
}

/**
 * Enables or disables a user
 * @param {string} username User name
 * @param {string} status Target status value ("enable" | "disable" } 
 */
async function modifyUserStatus(username, status) {
  const isEnabled = status === "enable" ? true : false;
  const userUpdated = await docClient.update({
    TableName: UsersTableInfo.TableName,
    Key: {
      [UsersTableInfo.HashKey]: username
    },
    UpdateExpression: `SET enabled = :en`,
    ExpressionAttributeValues: {
      ':en': isEnabled
    }
  }).promise();
  return (!!userUpdated);
}

/**
 * Validates if a set of credentials map to a valid Admin user
 * @param {string} username User name
 * @param {string} userApiKey API Key
 */
async function checkIsAdmin(username, userApiKey) {
  //TODO: use authenticateUser here
  if (!username || !userApiKey) {
    return false;
  }
  const {
    enabled,
    isAdmin,
    apiKey
  } = await getUserRecord(username);
  const isValidAdmin = (enabled && isAdmin && apiKey === userApiKey);
  console.log(`Checked for Admin: ${JSON.stringify({username, userApiKey, enabled, isAdmin, apiKey, isValidAdmin})}`);
  return isValidAdmin;
}

module.exports = {
  getUsers,
  getUsersInfo,
  getUserRecord,
  provisionUser,
  authenticateUser,
  modifyUserStatus,
  checkIsAdmin,
  updateUserTags,
  getUserTags
};