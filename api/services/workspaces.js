'use strict';
const {
    ok,
    badRequest,
    fail,
    html
} = require('./response');


const TenantsController = require('./tenants');
const tenantsController = new TenantsController();

const CloudsController = require('./clouds');
const cloudsController = new CloudsController();

const Ec2ClientManager = require('./ec2Client');
const clientManager = new Ec2ClientManager();

// const WorkspacesController = require('./workspaces');

module.exports.handler = async (event, context) => {
    try {
        const eventBody = (event && event.body && JSON.parse(event.body)) || {};
        const queryParams = (event && event.queryStringParameters) || {};
        const pathParams = (event && event.pathParameters) || {};
        const eventClaims = event.requestContext.authorizer;

        const { tenantId, tenantValid, tenantMessage } = await tenantsController.validateTenant(event);
        if (!tenantValid) {
            return badRequest({ message: tenantMessage });
        } else {
            cloudsController.init({ tenantId });
        }

        const wsController = new WorkspacesController();
        await wsController.init(pathParams);

        const methodResource = `${event.httpMethod} ${event.resource}`;
        console.log(`: methodResource`, methodResource);

        switch (methodResource) {

            // Get the Workspaces for current user
            case 'GET /clouds/{accountId}/regions/{region}/workspaces': {
                console.time(`Workspaces request - ${context.awsRequestId}`);
                const userEmail = eventClaims["email"];
                const userRole = eventClaims["custom:appRole"];
                const directories = await wsController.getDirectories();
                let workspaces;
                if (userRole === 'Admin') {
                    console.log(`fetching all workspaces for tenant account (Admin)`);
                    workspaces = await wsController.getAllWorkspaces(directories);
                } else {
                    const userTags = eventClaims["custom:userTags"];
                    console.log(`fetching workspaces assigned to user, tags`, userEmail, userTags);
                    workspaces = await wsController.getWorkspaces(directories, userEmail, userTags);
                }
                console.timeEnd(`Workspaces request - ${context.awsRequestId}`);
                return ok(workspaces);
            }
            // Get the details for single Workspace
            case 'GET /clouds/{accountId}/regions/{region}/workspaces/{workspaceId}': {
                const { workspaceId } = pathParams;
                const workspaceDetails = await wsController.getWorkspaceDetails(workspaceId);
                return ok(workspaceDetails);
            }

            case 'POST /clouds/{accountId}/regions/{region}/workspaces/{workspaceId}/{action}': {
                const { workspaceId, action } = pathParams;
                const actionResult = await wsController.modifyWorkspace({ workspaceId, action });
                return ok(actionResult);
            }

            default:
                return badRequest(`Invalid resource requested.`);
        }
    } catch (err) {
        console.error(err);
        return fail({ message: err.message });
    }
}

class WorkspacesController {

    async init(pathParams) {
        const { accountId, cloud, region } = await this._getCloudRegion(pathParams);

        this._WORKSPACES_NOT_SUPPORTED = `WorkSpaces is not supported in this region.`;
        const { workspacesClient } = await this._getWorkspacesClient(cloud, region);
        this._workspacesClient = workspacesClient;

        this._WORKDOCS_NOT_SUPPORTED = `WorkDocs is not supported in this region.`;
        const { workdocsClient } = await this._getWorkDocsClient(cloud, region);
        this._workdocsClient = workdocsClient;
    }

    /** Extracts region and translates Account ID to cloud connection object  */
    async _getCloudRegion(pathParams) {
        const { accountId, region } = pathParams;
        const cloud = await cloudsController.getCloud(accountId);
        return { accountId, cloud, region };
    }

    /** Constructs a WorkSpaces client object */
    async _getWorkspacesClient(cloud, region) {
        const message = this._WORKSPACES_NOT_SUPPORTED;
        try {
            const workspacesClient = await clientManager.getEc2Client({ cloud, region, service: 'WorkSpaces' });
            const testBundles = await workspacesClient.describeWorkspaceBundles({ Owner: 'AMAZON' }).promise();
            return { workspacesClient, message };
        } catch (wsErr) {
            console.error('getWorkspacesClient - wsErr: ', JSON.stringify(wsErr));
            if (wsErr.code === 'UnknownEndpoint') {
                throw new Error(message);
            }
            throw wsErr;
        }
    }

    /** Constructs a WorkDocs client object */
    async _getWorkDocsClient(cloud, region) {
        const message = this._WORKDOCS_NOT_SUPPORTED;
        try {
            const workdocsClient = await clientManager.getEc2Client({ cloud, region, service: 'WorkDocs' });
            return { workdocsClient, message };
        } catch (wdErr) {
            console.error('getWorkDocsClient - wdErr: ', JSON.stringify(wdErr));
            if (wdErr.code === 'UnknownEndpoint') {
                throw new Error(message);
            }
            throw wdErr;
        }
    }

    /** Gets the Directories registered with WorkSpaces */
    async getDirectories() {
        const { Directories: directories } = await this._workspacesClient.describeWorkspaceDirectories().promise();
        if (!directories || directories.length === 0) {
            throw new Error(`No directories are registered with the WorkSpaces service in this cloud & region. Please create a new directory and/or register it with WorkSpaces.`);
        }
        console.log(`getWorkspaces -> registered directories `, JSON.stringify(directories));
        return directories ;
    }

    /** Gets all the Workspaces across all registered directories */
    async getAllWorkspaces(directories) {
        
        const { Workspaces } = await this._workspacesClient.describeWorkspaces({
            // DirectoryId: directory.DirectoryId,
            // UserName: foundUser.Username
        }).promise();
        // console.log(`: WorkspacesController -> getAllWorkspaces -> Workspaces`, JSON.stringify(Workspaces));

        const userWorkspaces = [];
        for (const workspace of Workspaces) {
            console.log(`: WorkspacesController -> workspace`, workspace);
            const {WorkspaceId, DirectoryId, UserName } = workspace;
            const workspaceDirectory = directories.find(dir => dir.DirectoryId === DirectoryId);
            const directoryUserList = await this._queryDirectory([workspaceDirectory], u => u.Username === UserName);

            for (const { directory, foundUser } of directoryUserList) {
                const { DirectoryId, DirectoryName, DirectoryType, RegistrationCode } = directory;
                const { EmailAddress, GivenName, Surname, OrganizationId, Username, Status } = foundUser;
                userWorkspaces.push({ 
                    ...workspace, 
                    Directory: { DirectoryId, DirectoryName, DirectoryType, RegistrationCode }, 
                    User: { EmailAddress, GivenName, Surname, OrganizationId, Username, Status } 
                });
            }
        }
        for (const workspace of userWorkspaces) {
            // await this.attachConnectionStatus(workspace);
            await this.attachBundleInfo(workspace);
            // await this.attachTags(workspace);
        }
        console.log(`: userWorkspaces`, JSON.stringify(userWorkspaces));
        return userWorkspaces;
    }

    /** Gets all the Workspaces assigned to a single user, across all registered directories */
    async getWorkspaces(directories, userEmail, userTags) {

        const directoryUserList = await this._queryDirectory(directories, u => u.EmailAddress === userEmail);
        console.log(`: getWorkspaces -> directoryUserList`, JSON.stringify(directoryUserList));

        const userWorkspaces = [];
        for (const { directory, foundUser } of directoryUserList) {
            console.log(`DirectoryId, foundUser`, directory.DirectoryId, directory.DirectoryName, foundUser.Username);

            const { Workspaces } = await this._workspacesClient.describeWorkspaces({
                DirectoryId: directory.DirectoryId,
                UserName: foundUser.Username
            }).promise();

            const { DirectoryId, DirectoryName, DirectoryType, RegistrationCode } = directory;
            const { EmailAddress, GivenName, Surname, OrganizationId, Username, Status } = foundUser;
            const directoryWorkspaces = Workspaces.map(workspace => {
                return { 
                    ...workspace, 
                    Directory: { DirectoryId, DirectoryName, DirectoryType, RegistrationCode }, 
                    User: { EmailAddress, GivenName, Surname, OrganizationId, Username, Status } 
                };
            });

            userWorkspaces.push(...directoryWorkspaces);
        }
        for (const workspace of userWorkspaces) {
            // await Promise.all(
            //     [
            //         this.attachConnectionStatus(workspace),
                    await this.attachBundleInfo(workspace);
            //         this.attachTags(workspace)
            //     ]
            // );
        }
        // console.log(`: userWorkspaces`, JSON.stringify(userWorkspaces));
        return userWorkspaces.filter(ws => this.filterByUserTags(ws.Tags, userTags));
    }

    async getWorkspaceDetails(workspaceId) {
        // get workspace object
        const { Workspaces } = await this._workspacesClient.describeWorkspaces({
            WorkspaceIds: [workspaceId]
        }).promise();
        if (!Workspaces || (Workspaces.length !== 1)) {
            return badRequest({ message: `Workspace requested does not exist.` });
        }
        const workspace = { WorkspaceId: Workspaces[0].WorkspaceId };
        await Promise.all(
            [
                this.attachConnectionStatus(workspace),
                // this.attachBundleInfo(workspace),
                this.attachTags(workspace)
            ]
        );
        return workspace;
    }

    filterByUserTags(workspacesTags, userTags) {
        // userTags = [
        //     {
        //         "Name": "tag:team",
        //         "Values": [
        //             "Exostack"
        //         ]
        //     }
        // ];
        // workspacesTags = [
        //     { Key: 'exostack:requester', Value: 'lalitr@gmail.com' },
        //     { Key: 'exostack:workflowRequestId', Value: 'F91Pz0ZMD' },
        //     { Key: 'team', Value: 'Exostack' },
        //     {
        //         Key: 'exostack:workflow',
        //         Value: '8f9594ca-8658-4b6b-a586-03ee29162adb - TheDirector'
        //     }];
        console.log(`: filterByUserTags -> userTags1`, typeof userTags, userTags);
        if (!userTags && !workspacesTags) {
            return false;
        }
        userTags = JSON.parse(userTags);
        console.log(`: filterByUserTags -> userTags2`, typeof userTags, userTags);
        userTags = JSON.parse(userTags).map(t => { 
            return { 
                Key  : t.Name.split(':')[1],
                Value: t.Values[0]
            } 
        });
        console.log(`: filterByUserTags -> userTags3`, userTags);
        const tagMatch = workspacesTags.find((wst) => {
            return userTags[0].Key === wst.Key && userTags[0].Value === wst.Value;
        });
        console.log(`: filterByUserTags -> tagMatch`, tagMatch);
        return !!tagMatch;
    }

    async attachTags(workspace) {
        await this._workspacesClient.describeTags({
            ResourceId: workspace.WorkspaceId
        }).promise()
        .then(({ TagList }) => {
            console.log(`: getTags -> TagList`, TagList);
            workspace.Tags = TagList;
        }).catch(tagerr => {
            console.error(`Error fetching Tags for Workspace: ${workspace.WorkspaceId}`, tagerr);
        });
    }

    async attachBundleInfo(workspace) {
        await this._workspacesClient.describeWorkspaceBundles({
            BundleIds: [workspace.BundleId]
        }).promise().then(bundle => {
            const { Bundles: [{ BundleId , Name, Description }] } = bundle;
            console.log(`: Name, Description`, BundleId , Name, Description);
            workspace.Bundle = { BundleId , Name, Description };
        }).catch(bundlerr => {
            console.error(`Error fetching Bundle details for Workspace: ${workspace.WorkspaceId}`, bundlerr);
        });
    }

    async attachConnectionStatus(workspace) {
        await this._workspacesClient.describeWorkspacesConnectionStatus({
            WorkspaceIds: [workspace.WorkspaceId]
        }).promise()
            .then(connection => {
                const { WorkspacesConnectionStatus: [{ ConnectionState, ConnectionStateCheckTimestamp, LastKnownUserConnectionTimestamp }] } = connection;
                console.log(`: Connection`, workspace.WorkspaceId, ConnectionState, ConnectionStateCheckTimestamp, LastKnownUserConnectionTimestamp);
                workspace.Connection = { ConnectionState, ConnectionStateCheckTimestamp, LastKnownUserConnectionTimestamp };
            })
            .catch(connerr => {
                console.error(`Error fetching connections status for Workspace: ${workspace.WorkspaceId}`, connerr);
            });
    }

    /** Queries the WorkSpaces directories to resolve user email to userName */
    async _queryDirectory(directories, predicate) {
        const userDirectoryRecords = [];
        for (const directory of directories) {
            
            let nextToken;
            do {
                console.log(`: _queryDirectory -> nextToken, directory, predicate`,  nextToken, directory.DirectoryId, predicate);
                let nextUsers;
                ({ Users: nextUsers, Marker: nextToken } = await this._workdocsClient.describeUsers({
                    OrganizationId: directory.DirectoryId,
                    Include: 'ACTIVE_PENDING',
                    Marker: nextToken
                }).promise());

                const foundUser = nextUsers.find(predicate);
                if (foundUser) {
                    userDirectoryRecords.push({
                        directory,
                        foundUser
                    });
                }
            } while (nextToken !== null);
        }
        return userDirectoryRecords;
    }

    async _queryUserDetails(userName) {
        let nextToken;
        do {
            let nextUsers;
            ({ Users: nextUsers, Marker: nextToken } = await this._workdocsClient.describeUsers({
                OrganizationId: directory.DirectoryId,
                Include: 'ACTIVE_PENDING',
                Marker: nextToken
            }).promise());

            const foundUser = nextUsers.find(u => u.EmailAddress === userEmail);
            if (foundUser) {
                userDirectoryRecords.push({
                    directory,
                    foundUser
                });
            }
        } while (nextToken !== null);
    }

    async modifyWorkspace({ workspaceId, action }) {
        let result;
        switch(action) {
            case 'start':
                result = await this._workspacesClient.startWorkspaces({
                    StartWorkspaceRequests: [{
                        WorkspaceId: workspaceId
                    }]
                }).promise();
                break;

            case 'stop':
                result = await this._workspacesClient.stopWorkspaces({
                    StopWorkspaceRequests: [{
                        WorkspaceId: workspaceId
                    }]
                }).promise();
                break;          

            case 'reboot':
                result = await this._workspacesClient.rebootWorkspaces({
                    RebootWorkspaceRequests: [{
                        WorkspaceId: workspaceId
                    }]
                }).promise();
                break;

            case 'rebuild':
                result = await this._workspacesClient.rebuildWorkspaces({
                    RebuildWorkspaceRequests: [{
                        WorkspaceId: workspaceId
                    }]
                }).promise();
                break;

            case 'remove':
                result = await this._workspacesClient.terminateWorkspaces({
                    TerminateWorkspaceRequests: [{
                        WorkspaceId: workspaceId
                    }]
                }).promise();
                break;

            default:
                throw new Error(`Invalid action requested.`);
        }
        return result;
    }
};