'use strict';

const {
  ok,
  badRequest,
  fail
} = require('./response');


const TenantsController = require('./tenants');
const tenantsController = new TenantsController();

const {
  checkIsAdmin,
  getUsersInfo,
  provisionUser,
  authenticateUser,
  modifyUserStatus,
  getUsers,
  updateUserTags,
  getUserTags
} = require('./user');


module.exports.modifyUser = async (event, context) => {
  try {
    const { 'x-api-key': apiKey  } = event.headers;
    const { tenantId, tenantStatus, tenantValid, registrationType, createdAt } = await tenantsController.validateTenant(event);

    if (event.httpMethod === 'GET') {
      switch(event.resource) {
        case '/subscription':
          console.log(event.resource, tenantId, tenantStatus, tenantValid, createdAt);
          return ok({ tenantId, tenantStatus, tenantValid, registrationType, createdAt });
        case '/users':
          console.log('getUser', tenantId);
          const users = await getUsers(tenantId);
          return ok(users);
          // const usersInfo = await getUsersInfo();
          // return ok(usersInfo.filter(u => u.apiKey !== apiKey));
        case '/users/{username}/tags':
          const username = event && event.pathParameters["username"];
          const userTags = username && await getUserTags(username);
          return ok(userTags);
      }
    }
    // console.log(event);
    const {
      username,
      userSecret,
      newUserApiKey,
      isAdmin,
      status,
      userTags
    } = event && event.body && JSON.parse(event.body);
    console.log(`Received request for ${username}`);

    switch (event.resource) {
      case '/users/{username}/tags':
          const username = event && event.pathParameters["username"];
          console.log('updateUserTags', username, userTags);
          const tagsUpdated = await updateUserTags(username, userTags);
          return ok(tagsUpdated);
      // case '/users/create':
      //   const newUser = await provisionUser(username, newUserApiKey, isAdmin);
      //   return ok(newUser);
      // case '/users/auth':
      //   const userAuth = await authenticateUser(username, userSecret);
      //   return ok(userAuth);
      // case '/users/status':
      //   const statusChanged = await modifyUserStatus(username, status);
      //   return ok(statusChanged);
      default:
        return badRequest(`Invalid resource requested.`);
    }
  } catch (err) {
    return fail(err);
  }
}



