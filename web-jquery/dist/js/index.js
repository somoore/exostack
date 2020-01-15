
import  
{
    alert,
    uuidv4,
    rolePolicy,
    getFeatures,
    getApiBaseURL,
    getAccountTypes,
    getRoleARNPrefix,
    getHostingAccount,
    getRoleConsolePath,
    getCloudFormationURL,
    getAccountTypeDisplay,
    getCloudAccountConfig,
    GovCloudAccountType,
    PubCloudAccountType,
    REFRESH_INTERVAL_MINUTES,
    COGNITO_USERPOOL_ENABLED,
    MSTSC_SERVICE_ENDPOINT as mstscServiceEndpoint,
} from './clientConfig.js';


import {
    userSignUp,
    getCurrentAuthUser,
    getUserInfoFromAuthTokens,
    userSignIn,
    confirmUser,
    setupMfaTOTP,
    verifyMFAToken,
    changeMFA,
    changeMFAPreference,
    getCognitoUserData,
    userSignOut,
    getAuthorizationHeader,
    updateUserTags
} from './cognitoModule.js';

(function ($) {

    let API_KEY, USER_NAME, USER_ISADMIN, USER_ROLE;

    async function requestData(request) {
        let apiBaseURL;
        const { selectedAccountType, selectedAccountId } = getSelectedAccountType();
        const { selectedRegionId } = getSelectedRegion();
        // console.log(`: requestData ->`, selectedAccountType, selectedAccountId, selectedRegionId);

        request.apiContext = request.apiContext || selectedAccountType;
        apiBaseURL = getApiBaseURL(request.apiContext);

        // if (request.apiContext) { // apply the context provided
        //     apiBaseURL = getApiBaseURL(request.apiContext);
        // } else { // apply the context of the current selection
        //     apiBaseURL = getApiBaseURL(selectedAccountType);
        // }
        // console.log(`: requestData -> apiBaseURL`, apiBaseURL);

        request.headers = await getHeaders();
        request.contentType = request.contentType || 'application/json';

        request.url = request.url
                        .replace(/AWS_ACCOUNT_ID/g, selectedAccountId)
                        .replace(/REGION/g, selectedRegionId);
        // console.log(request.apiContext, request.method, request.url);

        if (request.isRelative || request.url.startsWith('/')) {
            request.url = `${apiBaseURL}${request.url}`
        }
        // console.log('requestData', request.method, request.url, request.headers);
        return $.ajax(request);
    }

    async function handleCognitoAuthentication(event) {
        event.preventDefault();
        const username   = $('#emailInputSignin').val();
        const userSecret = $('#apiKeyInputSignin').val();

        $('#loadDiv').removeAttr('hidden').show();
        try {
            const {userEmail, appRole} = await userSignIn(username, userSecret)
            await handleAuthSuccess(userEmail, appRole);
        } catch(e) {
                if (e.code === 'UserNotConfirmedException') {
                    const confirmationCode = prompt('Please enter the confirmation code sent to your email.');
                    if (confirmationCode === null) {
                        alert(`<span>Confirmation code not received. <br/> Cannot sign-in until email is confirmed!</span>
                                <button class="btn-flat toast-action">Resend Code (TODO)</button>`);
                        // TODO: resendConfirmationCode
                        throw e;
                    } else {
                        confirmUser(username, confirmationCode)
                            .then(() => {
                                alert(`Congrats! Your email is confirmed. <br/> Please proceed to sign-in`);
                            })
                            .catch(e => {
                                alert(`Hmm, that confirmation code doesn't look right. <br/> Please check and retry.`);
                            });
                    }
                } else {
                    let errorMessage = '';
                    if (e.code === 'PasswordResetRequiredException') {
                        errorMessage = `<span>Admin has requested a reset for your password <br/> Please change your password now!</span>
                                    <button class="btn-flat toast-action">Reset password (TODO)</button>`;
                        // TODO: call forgotPassword
    
                    } else if (e.code === 'UserNotFoundException')  {
                        errorMessage = `<span>Hmm, looks like you haven't registered yet! <br/> <a href="register.html" class="text-light bg-info">Sign up to get started now!</a><span>`;
                    } else if (e.code === 'NotAuthorizedException')  {
                        errorMessage = 'Please check your credentials and retry, or contact your admin for assistance.';
                    } else if (e.code === 'CodeMismatchException')  {
                        errorMessage = 'Hmm, that code does not look valid. <br/>Please check and retry, or contact your admin for assistance.';
                    } else {
                        console.error('handleCognitoAuthentication', e);
                        errorMessage = `<span>Sorry, we seem to have hit a problem authenticating your credentials. Please retry or contact admin for assistance. <br/> <small>(${e.message})</small></span>`;
                    }
                    alert(errorMessage);
                    // $('#auth-message-error').html(errorMessage);
                    // $('.auth-message').show();
                    // $('.auth-message').removeAttr('hidden');
                }
        } finally {
            $('#loadDiv').hide();
        }
    }

    function handleAuthentication(e) {
        e.preventDefault();
        const username = $('#emailInputSignin').val();
        const userSecret = $('#apiKeyInputSignin').val();
        // console.log( username, userSecret );
        requestData({
            method: 'POST',
            url: `/users/auth`,
            headers: {
                'x-api-key': userSecret
            },
            data: JSON.stringify({
                username,
                userSecret
            })
        }).then((authData) => {
            const { authenticated, isAdmin } = authData;
            if (authenticated) {
                API_KEY = userSecret;
                USER_NAME = username;
                handleAuthSuccess(username, isAdmin ? 'Admin' : 'User');
            } else {
                $('#auth-message').show();
                $('#auth-message').removeAttr('hidden');
            }
        }).catch(err => {
            console.log(err.responseText, status, err);
            alert(`<span>Sorry, we seem to have hit a problem authenticating your credentials. Please retry or contact admin for assistance. <br/> <small>(${e.message})</small></span>`);
            // $('#auth-message-error').show();
            // $('#auth-message-error').removeAttr('hidden');
        });
    }

    async function handleAuthSuccess(username, userRole) {
        USER_NAME = username;
        USER_ROLE = userRole;
        USER_ISADMIN = (USER_ROLE === 'Admin');
        const fetched = await fetchCloudsAndRegions();
        if (!fetched) { 
            console.log(`Sorry, looks like there's a problem with your account configuration! <br/> Please contact your Admin for assistance.`);
            alert(`Sorry, looks like there's a problem with your account configuration! <br/> Please contact your Admin for assistance.`);
            return false;
        }
        $('.unauthenticated').hide();
        $('.authenticated').removeAttr('hidden').show();
        $('#loggedin-username').text(username + (userRole === 'User' ? '' : ` (${userRole})`));

        if (USER_ISADMIN) {
            $('.admin').show().removeAttr('hidden');
        } else {
            $('.admin').hide();
        }
    }

    async function fetchCloudsAndRegions() {
        const clouds = await getClouds();
        // console.log(`: fetchCloudsAndRegions -> clouds`, clouds);
        if (!clouds || clouds.length === 0) {
            console.log(`No clouds found!`, clouds.length);
            alert(`Uh-oh, No cloud connections found!`);
            return false;
        }
        else {
            const options = clouds.map(
                (c, i) => `<option data-account-type="${c.AccountType}" value="${c.AccountId}">${c.DisplayName} [${c.AccountTypeDisplay}]</option>`);
                // (c, i) => `<option data-account-type="${c.AccountType}" value="${c.AccountId}" ${i === 0 ? 'selected' : ''}>${c.DisplayName} [${c.AccountTypeDisplay}]</option>`);
            options.push(`<option disabled="disabled">${'.'.repeat(50)}</option><option value="${ADD_EDIT_CLOUDS}">Add or Edit Clouds...</option>`);
            const cloud0 = clouds[0];
            $('#cloudSelector')
                .data('prev', cloud0.AccountId)
                .html(options.join(''))
                .val(cloud0.AccountId)
                // .off('change').on('change', handleCloudChange)
                .trigger('change');
                // .prop('selected', true);
            // await handleCloudChange();
            return true;
        }
    }

    const ADD_EDIT_CLOUDS = '__ADD_EDIT_CLOUDS__';

    async function getClouds() {
        const allClouds = [];
        const [govClouds, pubClouds] = await Promise.all(
            getAccountTypes().map(({accountType}) => {
                // console.log(`: getClouds -> accountType`, accountType);
                return getCloudsByAccountType(accountType);
            })
        );
        // console.log(`: getClouds -> govClouds, pubClouds`, govClouds, pubClouds);
        govClouds && allClouds.push(...govClouds);
        pubClouds && allClouds.push(...pubClouds);
        // console.log(`completed fetching clouds`, allClouds);
        return allClouds;
    }

    async function getCloudsByAccountType(accountType) {
        try {
            const clouds = await requestData({
                method: 'GET',
                url: `/clouds`,
                apiContext: accountType,
            });
            return clouds.map(c => {
                return { ...c, AccountTypeDisplay: getAccountTypeDisplay(accountType) }
            });
        } catch (err) {
            console.error(`Error fetching clouds for account type ${accountType}...`, err);
        }
    }

    async function handleCloudChange(e) {
        const newCloud = $('#cloudSelector').val();
        const $this = $('#cloudSelector');
        if (newCloud === ADD_EDIT_CLOUDS) {
            $this.val($this.data('prev')); //revert to prev value
            await initializeTenantConfigInfo();
            return false;
        }
        console.log(`CLOUD changed to: ${newCloud}`);
        $this.data('prev', newCloud);
        await getRegions();
    }
    
    async function getRegions() {
        try {
            const regions = await requestData({
                method: 'GET',
                url: `/clouds/AWS_ACCOUNT_ID/regions`,
            });
            const options = regions.map(r => `<option value=${r}>${r}</option>`).join('');
            $('#regionSelector')
                .html(options)
                .val(regions[0])
                .triggerHandler('change');
                // .prop('selected', true)
            
            // const features = getFeaturesCurrent();
            // await fetchAllResources(features);
        } catch (err) {
            console.log(`: getRegions -> err`, err);
            // TODO: alert();
        }
    }

    function getSelectedAccountType() {
        const selectedAccountId   = $('#cloudSelector').val();
        const selectedCloudOption = $(`#cloudSelector option[value="${selectedAccountId}"]`);
        const selectedAccountType = selectedCloudOption.data('account-type');
        // console.log(`======================= > selectedAccountType`, selectedAccountType);
        return { selectedAccountType, selectedAccountId };
    }

    function getSelectedRegion() {
        const selectedRegionId     = $(`#regionSelector`).val();
        const selectedRegionOption = $(`#regionelector option[value="${selectedRegionId}"]`);
        return { selectedRegionId };
    }

    function getFeaturesCurrent() {
        const {selectedAccountType} = getSelectedAccountType();
        const features = getFeatures(selectedAccountType);
        return features;
    }

    async function handleRegionChange(e) {
        console.log(`REGION changed to: ${e.target.value}`);
        const features = getFeaturesCurrent();
        // REGION = e.target.value;
        console.time('fetchAllResources');
        await fetchAllResources(features);
        console.timeEnd('fetchAllResources');
    };

    async function fetchAllResources(features) {
        initializeTabs(features);
        const promises = [
            features.EC2Instances && getInstancesInfo(),
            features.EC2Instances && USER_ISADMIN && getVpnAccessInfo(),
            features.WorkSpaces && getWorkspacesInfo(),
            features.S3 && getS3BucketsInfo(),
            initializeWorkflows(features)
        ];
        return Promise.all(promises);
    }

    async function initializeWorkflows(features) {
        initializeWorkflowTypes(features);
        const enableWorkflows = (features.Workflows.EC2 || features.Workflows.WorkSpaces);
        return Promise.all([
            enableWorkflows && getWorkflowsList(),
            enableWorkflows && getWorkflowRequests(),
            enableWorkflows && handleLoadWorkflowParams(), //{workflowFeatures: features.Workflows});
        ]).then(() => {
            $('#checkWorkflowRequestPricing').toggle(features.Workflows.ShowPricing);
            $('#selectWorkflowPricing').toggle(features.Workflows.ShowPricing);
        });
            
    }

    function initializeWorkflowTypes(features) {
        $('#inputResourceType').empty();
        features.Workflows.EC2 && $('#inputResourceType').append(`<option value="EC2">EC2</option>`);
        features.Workflows.WorkSpaces && $('#inputResourceType').append(`<option value="WorkSpaces">WorkSpaces</option>`);
        $('#inputResourceType')
            .val($("#inputResourceType option:first").val())
            // .trigger('change')
            .formSelect();
    }

    function initializeTabs(features) {
        $('#pills-instances-tab').toggleClass('disabled', !features.EC2Instances);
        $('#pills-access-tab').toggleClass('disabled', !features.EC2Instances);
        $('#pills-workspaces-tab').toggleClass('disabled', !features.WorkSpaces);

        const enableWorkflows = (features.Workflows.EC2 || features.Workflows.WorkSpaces);
        $('#pills-workflowAdmin-tab').toggleClass('disabled', !enableWorkflows);
        $('#pills-workflowRequest-tab').toggleClass('disabled', !enableWorkflows);
        enableWorkflows || $('#pills-tab li:first-child a:not(.disabled)').tab('show');
    }

    async function getHeaders() {
        if (COGNITO_USERPOOL_ENABLED) {
            const authHeader = await getAuthorizationHeader();
            return {
                'Authorization': authHeader,
                'x-api-key': USER_NAME //TODO: remove, check service
            };
        }
        return {
            'x-api-key': API_KEY
        };
    }

    async function getSubscription() {
        return requestData({
            method: 'GET',
            url: `/subscription`,
            apiContext: PubCloudAccountType
        });
    }

    async function getInstancesInfo() {
        try {
            let data = await requestData({
                method: 'GET',
                url: `/clouds/AWS_ACCOUNT_ID/regions/REGION/instances`,
            });
            // console.table(data);
            data = await Promise.all(data.map(async (instanceInfo) => {
                const { instanceId } = instanceInfo;
                const routingConfig = await getSubnetRoutingConfig(instanceId);
                return { ...instanceInfo, routingConfig };
            }));
            const dataSorted = data.sort((a, b) => a.launchTime < b.launchTime ? 1 : -1);
            const tableRows = renderTableRows(dataSorted, instanceTableColumns, null, instanceTableFooterTemplate);
            $('#instancesInfoTable').html(tableRows);
            startTimeDisplayCounter();
            $('#instancesInfo').show();
        } catch (err) {
            console.error(err);
            // TODO: alert();
        }
    }

    const instanceTableColumns = [
        {
            header: 'Instance ID',
            column: 'instanceId'
        },
        {
            header: 'Instance Type',
            column: 'instanceType',
            optional: true
        },
        {
            header: 'Name',
            column: 'nameTag',
            optional: true
        },
        {
            header: 'State',
            column: 'state',
            optional: true
        },
        // {
        //     header: 'State Reason',
        //     column: 'stateReason'
        // },
        {
            header: 'Public DNS',
            column: 'publicDNS',
            optional: true
        },
        {
            header: 'Public IP',
            column: 'publicIpV4'
        },
        {
            header: 'Private IP',
            column: 'privateIp'
        },
        {
            header: 'Platform OS',
            column: 'platform',
            optional: true
        },
        {
            header: 'Actions',
            column: '',
            type :  'actions',
            template: (jsonItem) => {
                const { instanceId, platform, publicDNS, publicIpV4, vpcId, subnetId } = jsonItem;
                return `
            <div class="btn-group">
                <button type="button" class="btn btn-secondary btn-sm dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false">
                    Actions
                </button>
                <div class="dropdown-menu" class="actions-menu">
                    <a class="dropdown-item" data-instance="${instanceId}" data-action="start" href="#">Start</a>
                    <a class="dropdown-item" data-instance="${instanceId}" data-action="stop" href="#">Stop</a>
                    <a class="dropdown-item" data-instance="${instanceId}" data-action="reboot" href="#">Reboot</a>
                    <a class="dropdown-item" data-instance="${instanceId}" data-action="terminate" href="#">Terminate</a>
                    <a class="dropdown-item" data-instance="${instanceId}" data-action="console" href="#">Console</a>
                    <div class="dropdown-divider"></div>
                    <a class="dropdown-item" data-instance="${instanceId}" data-action="remote" 
                        data-platform="${platform}" data-public-dns="${publicDNS}" data-public-ipv4="${publicIpV4}" 
                        data-vpc-id="${vpcId}" data-subnet-id="${subnetId}"
                        href="#">Remote Access</a>
                    <!--
                    <a class="dropdown-item" data-instance="${instanceId}" data-action="vpnup" data-platform="${platform}" href="#">Enable VPN</a>
                    <a class="dropdown-item" data-instance="${instanceId}" data-action="vpndown" href="#">Disable VPN</a>
                    <a class="dropdown-item" data-instance="${instanceId}" data-action="connect" data-platform="${platform}" data-public-dns="${publicDNS}" data-public-ipv4="${publicIpV4}" href="#">Connect</a>
                    -->
                </div>
            </div>`
            }
        },
    ];

    const instanceTableFooterTemplate = (jsonItem) => {
        const {
            schedule: { expirationTime, leaseAction, leaseDuration, leaseDurationUnit },
            routingConfig: { enableSubnetRouting },
            instanceId, platform, publicDNS, publicIpV4, vpcId, subnetId
        } = jsonItem;
        if (enableSubnetRouting) {
            const subnetRoutingActive = `Dynamic Subnet Routing is ACTIVE for ${instanceId}. `;
            const leaseContent = expirationTime 
            ? `Lease action for making subnet ${leaseAction} will expire 
                    <time class="timeago" datetime="${new Date(expirationTime * 1000).toISOString()}"></time>`
            : `No active lease`;
            
            return `
            <!-- <div class="switch text-tiny">
                <label>
                    <span class="text-left text-tiny">Dynamic Subnet Routing</span>
                    <input type="checkbox" id="dsr_active_${instanceId}" checked>
                    <span class="lever"></span>
                </label>
            </div> -->
            <span class="text-left text-tiny">${subnetRoutingActive}</span> | 
            <span class="text-left text-tiny text-info">${leaseContent}.</span> |
            <span class="text-left text-tiny">
                <a data-instance="${instanceId}" data-action="remote" 
                    data-platform="${platform}" data-public-dns="${publicDNS}" data-public-ipv4="${publicIpV4}" 
                    data-vpc-id="${vpcId}" data-subnet-id="${subnetId}"
                    href="#">Click here to modify lease</a>
            </span>`;
        }
    }

    function renderTable(tableRows, options = { small: true, border: true, hover: true }) {
        // console.log(`: renderTable -> options`, options);
        return `<table class="table 
            ${options.small ? 'table-sm' : ''} 
            ${options.border ? 'table-bordered' : ''} 
            ${options.hover ? 'table-hover' : ''}">
        ${tableRows}</table>`;
    }

    function renderTableRows(jsonItems, columnHeaders, noDataFoundMessage, rowFooterTemplate) {
        const dataRows = renderRows(jsonItems, columnHeaders, noDataFoundMessage, null, rowFooterTemplate);
        const headerRow = renderHeader(columnHeaders);
        // const headerRow = Array.isArray(jsonItems) && jsonItems.length > 0 && renderHeader(columnHeaders);
        const tableRows = composeRows(headerRow, dataRows);
        return tableRows;
    }

    function composeRows(header, rows) {
        return `<thead class="thead-light">${header}</thead><tbody>${rows}</tbody>`;
    }

    function renderHeader(columnHeaders) {
        let colHeaders = columnHeaders.map(({ header, optional }) => `<th class="${optional ? 'd-none d-lg-table-cell' : ''}">${header || ''}</th>`).join('');
        // const [firstNonOptional] = columnHeaders.filter(h => !h.optional);
        // const extraColHeader = `<th class="d-lg-none">${firstNonOptional.header}</th>`;
        const extraColHeader = `<th class="d-lg-none"></th>`;
        colHeaders = `${extraColHeader}${colHeaders}`;
        return colHeaders;
    }

    function renderRows(jsonItems, columnHeaders, noDataFoundMessage, rowTemplate, rowFooterTemplate) {
        let rows;
        if (Array.isArray(jsonItems) && jsonItems.length > 0) {
            rows = [].concat(jsonItems.map(jsonItem => {
                if (rowTemplate) {
                    // console.log(`: renderRows -> rowTemplate`, rowTemplate);
                    return `${rowTemplate(jsonItem)}`;

                } else {

                    const cells = columnHeaders.map(header => {
                        const val = getCellValue(jsonItem, header);
                        return `<td class="${header.optional ? 'd-none d-lg-table-cell' : ''}">
                            <span class="d-inline-block text-wrap" style="max-width: 120px;">${val}</span>
                        </td>`;
                    }).join('');

                    const extraCell = columnHeaders.filter(h => h.optional).map(header => {
                        const val = getCellValue(jsonItem, header);
                        return `<li><em>${header.header}</em> : <strong>${val || '-'}</strong></li>`;
                    }).join('');

                    const row = `
                    <tr>
                        <td class="d-lg-none">
                            <i class="material-icons" data-toggle="popover"
                                data-content="<ul>${extraCell}</ul>">info</i>
                        </td>
                        ${cells}
                    </tr>`;
                    if (rowFooterTemplate) {
                        const footerRowContent = rowFooterTemplate(jsonItem);
                        const footerRow = footerRowContent 
                            && `<tr style="height:10px;">
                                <td colspan="${columnHeaders.length}"><div class="text-left text-small" >${footerRowContent}</div></td>
                            </tr>`;
                        return `${row}${footerRow}`;
                    }
                    return row;
                }
            })).join('');
        }
        else {
            noDataFoundMessage = noDataFoundMessage || `No data found. Check cloud, region & <a href="#" class="nav-tags">tags</a>.`;
            rows = `<tr><td colspan="${columnHeaders.length}" style="text-align: center">${noDataFoundMessage}</td></tr>`;
        }
        return rows;

        function getCellValue(jsonItem, header) {
            const { column, type, template, optional } = header;
            let val = jsonItem[column] || '';
            if (type === 'actions' && USER_ROLE === 'ReadOnly') {
                val = '<span class="text-warning bg-secondary">Read-only</span>';
            }
            else if (type === 'actions' || type === 'custom') {
                val = template(jsonItem);
            }
            return val;
        }
    }

    function startTimeDisplayCounter() {
        $('time.timeago').off().on('DOMSubtreeModified', (e) => {
            $(e.target).each((index, el) => {
                if (el.innerHTML === $.timeago.settings.strings.inPast) {
                    $(el).parent().html(`<span class="text-left text-warning bg-light">Subnet lease has expired! Route table will be updated shortly.</span>`);
                }
            });
        }).timeago();
    }

    function handleInstanceAction(instanceActionEvent) {
        instanceActionEvent.preventDefault();
        const navigated = navigateTags(instanceActionEvent);
        if (navigated) return;
        const instanceItem = $(instanceActionEvent.target);
        const instanceId   = instanceItem.data('instance');
        const action       = instanceItem.data('action');
        const platform     = instanceItem.data('platform');
        const port         = (platform === 'windows' ? 3389 : 22);
        const vpcId        = instanceItem.data('vpc-id');
        const subnetId     = instanceItem.data('subnet-id');
        // console.log(instanceId, action);
        if (action === 'remote') {
            return showRemoteConnectDialog(instanceId, platform, port, vpcId, subnetId);
        // } else if (action === 'connect') {           
        //     const publicDNS = instanceItem.attr('data-public-dns');
        //     const publicIpV4  = instanceItem.attr('data-public-ipv4');
        //     showConnectDialog(instanceId, platform, port, publicDNS, publicIpV4);
        //     return;
        } else {
            if (['terminate' /*, 'reboot', 'stop'*/ ].includes(action) && prompt(`Are you sure you want to ${action} the instance: ${instanceId} ?
            Warning: On an EBS-backed instance, the default action is for the root EBS volume to be deleted when the instance is terminated. Storage on any local drives will be lost. 
            Please type ${action.toUpperCase()} and click OK to confirm`) !== action.toUpperCase() ) {
                alert(`Confirmation not received, aborting termination!`);
                return false;
            }
            const data = { 'username': USER_NAME };
            submitInstanceAction(instanceId, action, data);
        }
    }

    function navigateTags(event) {
        if ($(event.target).hasClass('nav-remote')) {
            showRemoteConnectModal();
            return true;
        }
        if ($(event.target).hasClass('nav-tags')) {
            $('#userProfile').trigger('click');
            const userProfileInfoEl = document.querySelector('#userProfileInfo');
            M.Collapsible.getInstance(userProfileInfoEl).open(1);
            return true;
        }
    }

    async function showRemoteConnectDialog(instanceId, platform, port, vpcId, subnetId) {        
        $('#networkAutomationForm').trigger('reset');
        $('#subnetRoutingWorkflowId').val('');
        const [{ isValidSubnetState, message }, { sourceIp }, admins] = await Promise.all([
            validateSubnetState(instanceId), 
            getMyIP(), 
            USER_ISADMIN && await getUsers(), 
        ]);
        await initializeVpnAccess(instanceId, platform, port, sourceIp);
        await initializeSubnetRouting(instanceId, admins && admins.filter(u => u.isAdmin), isValidSubnetState, message, port, sourceIp);
        M.updateTextFields();

        showRemoteConnectModal();
    }

    function showRemoteConnectModal() {
        $('#remoteAccessModal').modal(//'show'
            {
                show: true,
                backdrop: 'static',
                keyboard: true
            });
    }

    async function initializeVpnAccess(instanceId, platform, port, sourceIp) {
        $('#newAddVpnAccessInstance').val(`${instanceId}`);
        $('#newAddVpnAccessPlatform').val(`${platform}`);
        $('#newAddVpnAccessPort').val(port);
        $('#newAddVpnAccessIPAddress').val(sourceIp);
        $('#addNewAddVpnAccessSubmit').off('click').on('click', (addNewAddVpnAccessEvent) => {
            addNewAddVpnAccessEvent.preventDefault();
            const port = $('#newAddVpnAccessPort').val();
            const ipAddress = $('#newAddVpnAccessIPAddress').val();
            const data = { username: USER_NAME, port, ipAddress };
            submitInstanceAction(instanceId, 'vpnup', data);
        });

        $('#removeVpnAccessSubmit').off('click').on('click', (deleteVpnAccessEvent) => {
            deleteVpnAccessEvent.preventDefault();
            const data = { username: USER_NAME };
            submitInstanceAction(instanceId, 'vpndown', data);
        });
    }

    async function validateSubnetState(instanceId) {
        let isValidSubnetState = true, message = '';
        const { VpcId, SubnetId, RouteTableId, IsMainRouteTable, HasInternetRoute, VpcHasInternetGateway } = await getSubnetState(instanceId);
        console.log(`:: validateSubnetState -> VpcId, SubnetId, RouteTableId, IsMainRouteTable, HasInternetRoute, VpcHasInternetGateway`, VpcId, SubnetId, RouteTableId, IsMainRouteTable, HasInternetRoute, VpcHasInternetGateway);

        if (IsMainRouteTable) {
            isValidSubnetState = false;
            message += `<li>Dynamic Subnet Routing is disabled for instances launched in subnets that are associated with the Main Route-table for the VPC. </li>`;
        }
        if (!VpcHasInternetGateway) {
            isValidSubnetState = false;
            message += `<li> Dynamic Subnet Routing requires Internet Gateway to be associated with the VPC. </li>`;
        }
        // if (HasInternetRoute) {
        //     isValid = false;
        //     message += `<li>Subnet associated with this instance already has a Internet route set up. </li>`; 
        // }

        outputSubnetState();

        return { isValidSubnetState, message: `<ul>${message}<ul/>` };

        function outputSubnetState() {
            // $('#subnetRoutingVpcId').val(VpcId);
            // $('#subnetRoutingSubnetId').val(SubnetId);
            // $('#subnetRoutingRouteTableId').val(RouteTableId);
            // $('#subnetRoutingRouteTableIsMain').val(IsMainRouteTable);
            const subnetRoutingInfo = `<ul>
            <li>VpcId : <strong>${VpcId}</strong></li>
            <li>SubnetId : <strong>${SubnetId}</strong></li>
            <li>RouteTableId : <strong>${RouteTableId}</strong></li>
            <li>Is Main RouteTable? : <strong>${IsMainRouteTable ? 'yes' : 'no'}</strong></li>
            <li>Has Internet Route? : <strong>${HasInternetRoute ? 'yes' : 'no'}</strong></li>
            <li>VPC has IGW? : <strong>${VpcHasInternetGateway ? 'yes' : 'no'}</strong></li>
            </ul>`;
            $('#subnetRoutingInfo').html(`<i class="material-icons md-24 md-light" data-toggle="popover" data-content="${subnetRoutingInfo}">router</i>`);
            // $('#subnetRoutingInfo').html(`<i class="material-icons">info</i>`);
        }
    }

    async function getSubnetState(instanceId) {
        return requestData({
            method: 'POST',
            url: `/clouds/AWS_ACCOUNT_ID/regions/REGION/instances/${instanceId}/routing`,
            data: JSON.stringify({ instanceId})
        });
    }

    async function getSubnetRoutingConfig(instanceId) {
        // const config = ROUTING_CONFIGS.find(rc => rc.instanceId === instanceId);
        return requestData({
            method: 'GET',
            url: `/clouds/AWS_ACCOUNT_ID/regions/REGION/workflows/instances/${instanceId}`,
        });
    }

    const subnetLeaseApproversItemTemplate = ({ username, isAdmin }) => 
        defaultItemTemplate({ marker: 'lease-approver', value: username, title: `${username} ${isAdmin ? ' (Admin)': ''} `, desc: '', namespaceId: true });

    async function initializeSubnetRouting(instanceId, admins, isValidSubnetState, message, defaultPort, defaultSourceIp) {

        // main workflow
        // const { isValid, message } = await validateSubnetState(instanceId);
        if (!isValidSubnetState) {
            await changeLeaseViewState({ enable: 'blocked' });
            return changeSubnetConfigViewState({ subnetRoutingState: 'blocked', message });
        } else {
            bindEventHandlers();
            const { workflowId, enableSubnetRouting, approvers } = await getSubnetRoutingConfig(instanceId);
            preserveSubnetRoutingConfig(workflowId, approvers);
            if (USER_ISADMIN) {
                changeSubnetConfigViewState({ subnetRoutingState: enableSubnetRouting, admins, approvers });
            } else {
                changeSubnetConfigViewState({ subnetRoutingState: enableSubnetRouting, message: `Please contact your Admin to enable Dynamic Subnet Routing for this instance.` });
            }
            await changeLeaseViewState({ enable: enableSubnetRouting });
        }

        function preserveSubnetRoutingConfig(workflowId, approvers) {
            $('#subnetRoutingWorkflowId').val(workflowId);
            $('#subnetRoutingAuthorizedApprovers').val(JSON.stringify(approvers));
        }

        function bindEventHandlers() {
            if (USER_ISADMIN) { // event handlers
                $('#saveRoutingConfiguration').off().on('click', { instanceId }, saveSubnetRoutingConfig);
                $('#enableSubnetRouting').off('change').on('change', e => {
                    const subnetRoutingEnabled = $(e.target).is(':checked');
                    $('#approveSubnetLease').prop('checked', false).prop('disabled', !subnetRoutingEnabled).trigger('change');
                });
                $('#approveSubnetLease').off().on('change', async (e) => {
                    const approvalRequired = $('#approveSubnetLease').is(':checked');
                    if (approvalRequired) {
                        $('#subnetLeaseApproversTable input[type="checkbox"]').prop('disabled', false);
                    }
                    else {
                        $('#subnetLeaseApproversTable input[type="checkbox"]').prop('disabled', true).prop('checked', false);
                        // $('#subnetLeaseApproversTable').hide();
                    }
                });
            }
            $('#requestAccessSubmit').off().on('click', { instanceId }, saveSubnetRoutingLease);
        }

        function changeSubnetConfigViewState({ subnetRoutingState, message, admins, approvers }) {
            if (subnetRoutingState === 'blocked') {
                showMessage(true, message);
                showOptions(false);
                return;
            } else if (!USER_ISADMIN) {
                showOptions(false);
                if (!subnetRoutingState) {
                    showMessage(true, message);
                } else {
                    showMessage(false);
                }
            } else {
                showMessage(false);
                showOptions(true);
                $('#enableSubnetRouting').prop('checked', subnetRoutingState).trigger('change');

                renderCollection(admins, '', 1, subnetLeaseApproversItemTemplate, 'subnetLeaseApproversTable');
                const approvalRequired = subnetRoutingState && Array.isArray(approvers) && approvers.length > 0 && approvers[0] !== 'auto-approve';
                $('#approveSubnetLease').prop('checked', approvalRequired && subnetRoutingState).trigger('change');
                bindArrayToCheckboxes(approvers, 'subnetLeaseApproversTable', 'lease-approver');

                if (subnetRoutingState === true) {
                    // const approversRequired = Array.isArray(approvers) && approvers.length > 0;
                    // $('#approveSubnetLease').prop('checked', approversRequired).trigger('change', approvers);
                    // $('#enableSubnetRouting').prop('disabled', false).prop('checked', enableSubnetRouting).trigger('change');

                } else if (subnetRoutingState === false) {
                }
            }

            function showOptions(show) {
                if (show) {
                    $('#subnetRoutingOptionsContainer').show();
                } else {
                    $('#subnetRoutingOptionsContainer').hide();
                }
            }

            function showMessage(show, message) {
                if (show) {
                    $('#subnetRoutingUserNotice').html(`NOTE: ${message}`).removeAttr('hidden').show();
                } else {
                    $('#subnetRoutingUserNotice').html('').prop('hidden', true).hide();
                }
            }
        }

        async function changeLeaseViewState({ enable }) {
            if (!enable || enable === 'blocked') {
                $('#subnetRoutingLeaseOptionsContainer').hide();
            } else {
                await initializeSubnetLease(instanceId);
                $('#subnetRoutingAddVpnAccessPort').val(defaultPort);
                $('#subnetRoutingAddVpnAccessIPAddress').val(defaultSourceIp);
                $('#subnetRoutingLeaseOptionsContainer').show();
            }
        }

        async function saveSubnetRoutingConfig(e) {
            const { instanceId }      = e.data;
            const workflowId          = $('#subnetRoutingWorkflowId').val();
            const enableSubnetRouting = $('#enableSubnetRouting').is(':checked');
            const approvalRequired    = $('#approveSubnetLease').is(':checked');
            const approvers           = $('#subnetLeaseApproversTable input[type="checkbox"]:checked').get().map(x => x.value);

            const config = {
                workflowId,
                instanceId,
                enableSubnetRouting,
                approvers: (enableSubnetRouting && approvalRequired && approvers.length > 0 && approvers) || ['auto-approve']
            };
            alert(`Dynamic Subnet Routing Config for instance ${instanceId} updated!`);

            const configWorkflow = { ...config, resourceType: 'SubnetRouting', workflowName: `SubnetRouting-${instanceId}` };
            const saved = await updateWorkflow(workflowId ? 'PATCH' : 'POST', configWorkflow);
            console.log(`:: saveSubnetRoutingConfig -> workflowId`, workflowId);
            preserveSubnetRoutingConfig(saved.workflowId, approvers);

            changeLeaseViewState({ enable: enableSubnetRouting });
        }

        async function saveSubnetRoutingLease(e) {
            const { instanceId } = e.data;

            const resourceType      = 'SubnetRouting';
            const requester         = USER_NAME;
            const workflowId        = $('#subnetRoutingWorkflowId').val();
            const leaseAction       = $('#subnetState').val();
            const leaseDuration     = $('#subnetleaseDuration').val();
            const leaseDurationUnit = $('#subnetleaseDurationUnit').val();
            const approvers         = JSON.parse($('#subnetRoutingAuthorizedApprovers').val());
            const ipAddress         = $('#subnetRoutingAddVpnAccessIPAddress').val();
            const port              = $('#subnetRoutingAddVpnAccessPort').val();

            const config = { 
                resourceType, requester, workflowId, approvers, instanceId, 
                leaseOptions: { leaseAction, leaseDuration, leaseDurationUnit } ,
                whitelist: { ipAddress, port }
            };

            await saveWorkflowRequest({ workflowRequest: config });
            alert('Lease requested!');
        }

        async function deleteSubnetRoutingLease(instanceId) {
            INSTANCE_ROUTING_LEASES = INSTANCE_ROUTING_LEASES.filter(rl => rl.instanceId !== instanceId);
        }

        async function getSubnetRoutingLease(instanceId) {
            return requestData({
                method: 'GET',
                url: `/clouds/AWS_ACCOUNT_ID/regions/REGION/schedules/${instanceId}/SubnetRouting`
            });
        }

        async function initializeSubnetLease(instanceId) {
            const { leaseAction = "0", leaseDuration = 1, leaseDurationUnit = "0", expirationTime } = await getSubnetRoutingLease(instanceId);
            $('#subnetState').val(leaseAction).formSelect();
            $('#subnetleaseDuration').val(leaseDuration);
            $('#subnetleaseDurationUnit').val(leaseDurationUnit).formSelect();
            expirationTime && $('#subnetRoutingCurrentLeaseExpiration').attr('datetime', new Date(expirationTime * 1000).toISOString()).timeago();
            // $('#subnetRoutingCurrentLeaseNotice').text(expirationTime ? `Current lease expiration: ${timeago.format(expirationTime * 1000)}` : `No current lease`);
        }
    }
    
    function showConnectDialog(instanceId, platform, port, publicDNS, publicIpV4) {
        console.log(instanceId, platform, port, publicDNS, publicIpV4);
        if (!publicDNS || !publicIpV4) {
            alert(`Uh-oh! Can't connect to the ${platform} instance ${instanceId}. <br/> Please check if it's in a running state`);
            return;
        }
        // if ((platform !== 'windows') || (window.location.protocol !== 'http')) { //TEMPORARY
        //     alert(`Sorry! Due to a temporary technical glitch, we are only supporting the Connect functionality for Windows instance when using HTTP, not ${window.location.protocol}`);
        //     return;
        // }

        $('#connectInstanceModalForm').trigger('reset');
        $('#connectInstanceId').val(`${instanceId}`);
        $('#connectInstancePlatform').val(`${platform}`);
        $('#connectInstancePublicIpV4').val(`${publicIpV4}`);
        $('#connectInstancePublicDNS').val(`${publicDNS}`);
        M.updateTextFields();
        $('#connectInstanceModal')
            // .removeClass('p-4')
            // .css('padding', '0')
            // .css('margin', '0')
            .css({'max-height':'100%'})
            .css('width', window.innerWidth)
            .css('height', window.innerHeight)
            ;
        $('#connectInstanceModal').modal({
            show: true,
            // focus: true,
            keyboard: true,
            backdrop: 'static',
        }).on('hidden.bs.modal', (e) => {
            // alert('popup closed');
            return false;
        });
        $('#connectInstanceSubmit').off('click').on('click', (connectInstanceEvent) => {
            connectInstanceEvent.preventDefault();
            const username = $('#connectUsername').val();
            const password = $('#connectPassword').val();
            const domain = $('#connectDomain').val() || null;
            if (!(username && password)) {
                alert(`Please provide the username and password to connect to the instance.`);
                return false;
            }
            // console.log('connecting to instance', instanceId, domain, username, password);
            connectInstance(publicDNS, domain, username, password);
        });
    }

    function connectInstance(publicDNS, domain, username, password) {
        // TODO:
        //  https://developers.google.com/web/updates/2018/08/offscreen-canvas
        //  https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas
        $('#connectInstanceModal .modal-dialog').hide();
        
        $('#connectInstanceToolbar').removeAttr('hidden').show();
        const canvas = Mstsc.$('mstscCanvas');
        canvas.style.display = 'inline';
        canvas.style.border = '1px thick solid black';
        canvas.top = 100; //$('#connectInstanceToolbar').prop('height');
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight - canvas.top;

        let client = Mstsc.client.create(canvas);

        $('#disconnectInstance').off('click').on('click', () => {
            if (client && confirm(`Are your sure you want to close this remote session with ${publicDNS}`)) {
                client.hangUp();
                client = null;
                handleConnectionHangUp();
            }
        });

        const clientCallbacks = {
            onConnected: () => {
                console.log('CONNECTED!');
                $('#connectInstanceProgress').hide();
                $('#disconnectInstance').removeAttr('disabled');
                // $('#connectInstanceToolbar').removeAttr('hidden').show();
            },
            onTimeout: (reason, timeoutValue) => {
                console.log(`onTimeout: ${reason}`, timeoutValue);
                handleConnectTimeout(reason);
            },
            onUpdate: (frames) => {
                $('#connectInstanceFrames').text(frames);
            },
            onClose: (reason) => {
                console.log('CLOSED', reason);
                handleConnectionHangUp();
            },
            onError: (err) => {
                console.error(err);
                if (err.code === 'NODE_RDP_PROTOCOL_X224_NEG_FAILURE') {
                    alert(`We were able to connect to your instance, but the RDP Network-level auth setting needs to be turned Off!`);
                } else if (err.code === 'ECONNRESET') {
                    handleConnectionHangUp();
                } else if (err.code === 'ETIMEOUT') {
                    handleConnectTimeout();
                }
            }
        };
        // publicDNS = 'ec2-3-212-53-190.compute-1.amazonaws.com';
        client.connect(mstscServiceEndpoint, publicDNS, domain, username, password, clientCallbacks, 20000);

        function handleConnectTimeout(reason) {
            alert(`Uh-oh, the connection attempt timed out! <br/>Please check to ensure that the instance is externally accessible and you've setup the correct access rule.`);
            handleConnectionHangUp();
        }

        function handleConnectionHangUp() {
            canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
            $('#connectInstanceModal .modal-dialog').show();
            $('#disconnectInstance').attr('disabled', true);
            $('#connectInstanceFrames').text('');
            $('#connectInstanceToolbar').hide();
            $('#mstscCanvas').hide();
        }
    }

    async function submitInstanceAction(instanceId, action, data) {
        try {
            const output = await postInstanceAction(instanceId, action, data);
            if (action === 'console') {
                const { consoleOut, consoleImageBase64 } = output;
                $('#consoleImage').attr('src', 'data:image/jpg;base64,' + consoleImageBase64);
                if (consoleOut) {
                    $('#consoleOutput').text(window.atob(consoleOut));
                }
                $('#consoleImageModal').modal('show');
                return;
            }
            const { message } = output;
            alert(message, null, null, 5000);

            getInstancesInfo();
            
            if (['vpnup', 'vpndown'].includes(action) && USER_ISADMIN) {
                getVpnAccessInfo();
            }
        } catch (err) {
            console.error(err);
            const message = err && err.responseJSON && err.responseJSON.message;
            alert(`<span>Uh-oh, there was an error performing the requested action for the instance ${instanceId}.<br/> <small>(${message})</small><span>`);
        }
    }

    async function postInstanceAction(instanceId, action, data) {
        return requestData({
            method: 'POST',
            url: `/clouds/AWS_ACCOUNT_ID/regions/REGION/instances/${instanceId}/${action}`,
            data: JSON.stringify(data),
        });
    }

    async function getMyIP() {
        return requestData({
            method: 'GET',
            url: `/whatsmyip`            
            }).catch(err => {
                console.log(err.responseText, status, err);
            });
    }

    const s3BucketTableColumns = [
        {
            header: 'Bucket Name',
            column: 'bucketName'
        },
        {
            header: 'Created',
            column: 'createdAt'
        }
    ];

    async function getS3BucketsInfo() {
        return false; //temporarily disabled
        return requestData({
            method: 'GET',
            url: `/clouds/AWS_ACCOUNT_ID/regions/REGION/s3Buckets`,
            }).catch(err => {
                console.log(err.responseText, status, err);
                $('#s3Bucket-action-error-detail').text(err.responseText);
                $('#s3Bucket-action-error').show();
            }).then( function(data) {
                //- console.table(data);
                const tableRows = renderTableRows(data, s3BucketTableColumns);
                $('#s3BucketsInfoTable').html(tableRows);
                $('#s3BucketsInfo').show();
            });
    }

    const userTableColumns = [
        {
            header: 'User Name',
            column: 'username'
        },
        {
            header: 'API Key',
            column: 'apiKey'
        },
        {
            header: 'Enabled',
            column: 'enabled'
        },
        {
            header: 'Actions',
            column: '',
            type :  'actions',
            template: (jsonItem) => {
                const {username} = jsonItem;
                return `
            <div class="btn-group">
                <button type="button" class="btn btn-secondary btn-sm dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false">
                    Actions
                </button>
                <div class="dropdown-menu" class="actions-menu">
                    <a class="dropdown-item" data-username="${username}" data-action="enable" href="#">Enable User</a>
                    <a class="dropdown-item" data-username="${username}" data-action="disable" href="#">Disable User</a>
                </div>
            </div>`
            }
        },
    ];

    async function getUsers() {      
        return requestData({
            method: 'GET',
            url: `/users`,
            apiContext: PubCloudAccountType
        });
    }

    async function handleUserAction(userActionEvent) {
        return false;
        userActionEvent.preventDefault();
        const username = $(userActionEvent.target).attr('data-username');
        const status = $(userActionEvent.target).attr('data-action');
        requestData({
            method: 'POST',
            url: `/users/status`,            
            beforeSend: function () {
                $('.user-message').hide();
            },
            data: JSON.stringify({
                username,
                status
            }),
            
            }).catch(err => {
                console.log(err.responseText, status, err);
                // $('#instance-action-id').text(instanceId);
                // $('#instance-action-error-detail').text(err.responseText);
                // $('#instance-action-error').show();
            }).then( async function(data) {
                const {message} = data;
                console.log(data, message);
                // $('#instance-action-message').text(message);
                // $('#instance-action-message').show();
                //get latest status
                await getUsers(); 
            });
    }

    async function handleAddNewUser(addNewUserEvent) {
        return false;
        addNewUserEvent.preventDefault();
        const newUsername = $('#newUsername').val();
        const newApiKey = $('#newApiKey').val();
        requestData({
            method: 'POST',
            url: `/users/create`,
            data: JSON.stringify({
                username: newUsername,
                newUserApiKey: newApiKey
            }),            
            }).catch(err => {
                console.log(err.responseText, status, err);
                $('#addnewuser-message').text(err.responseText);
            }).then( async function(data) {
                const {username, userSecret} = data;
                console.log(data, username, userSecret);
                $('#user-action-message').text(`Created new user with username: ${username} and API key: ${userSecret}) `);
                $('#user-action-message').show();
                $('#addNewUserModal').modal('hide');
                await getUsers(); //get latest status
            });
    }

    const vpnAccessTableColumns = [
        {
            header: 'From IP address',
            column: 'ipAddress'
        },
        {
            header: 'Port',
            column: 'port'
        },
        {
            header: 'Instance',
            column: 'instanceId'
        },
        {
            header: 'Created',
            column: 'createdAt',
            optional: true
        },
        {
            header: 'Expires ^',
            column: 'expiresAt',
            optional: true
        },
        {
            header: 'Created By',
            column: 'createdBy',
            optional: true
        },
        {
            header: 'Actions',
            column: '',
            type :  'actions',
            template: (jsonItem) => {
                const {instanceId, ipAddress, description} = jsonItem;
                return `
            <div class="btn-group">
                <button type="button" class="btn btn-secondary btn-sm dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false">
                    Actions
                </button>
                <div class="dropdown-menu" class="actions-menu">
                    <a class="dropdown-item" data-instance="${instanceId}" data-ipAddress="${ipAddress}" data-description="${description}" href="#">Delete Rule</a>
                </div>
            </div>`
            }
        },
    ];
    
    async function getVpnAccessInfo() {
        return requestData({
            method: 'GET',
            url: `/clouds/AWS_ACCOUNT_ID/regions/REGION/vpn/list/${USER_NAME}`
            }).catch(err => {
                console.log(err.responseText, status, err);
                $('#vpnaccess-action-error-detail').text(err.responseText);
                $('#vpnaccess-action-error').show();
            }).then( function(data) {
                //- console.table(data);
                const tableRows = renderTableRows(data, vpnAccessTableColumns);
                $('#vpnAccessInfoTable').html(tableRows);
                $('#vpnAccessInfo').show();
            });
    }

    function handleVpnAccessAction(vpnAccessActionEvent) {
        vpnAccessActionEvent.preventDefault();
        const navigated = navigateTags(vpnAccessActionEvent);
        if (navigated) return;
        const instance = $(vpnAccessActionEvent.target).attr('data-instance');
        const ipAddress = $(vpnAccessActionEvent.target).attr('data-ipAddress');
        const description = $(vpnAccessActionEvent.target).attr('data-description');
        requestData({
            method: 'POST',
            url: `/clouds/AWS_ACCOUNT_ID/regions/REGION/instances/${instance}/vpndeleterule`,
            beforeSend: function () {
                $('.vpnaccess-message').hide();
            },
            data: JSON.stringify({
                description,
                ipAddress
            })
        }).catch(err => {
            console.log(err.responseText, status, err);
            // $('#instance-action-id').text(instanceId);
            // $('#instance-action-error-detail').text(err.responseText);
            // $('#instance-action-error').show();
        }).then(data => {
            const {message} = data;
            console.log(data, message);
            //get latest status
            getVpnAccessInfo(); 
        });
    }

    function handleLoadUserProfile() {
        getCognitoUserData().then(userInfo => {
            // console.log(userInfo);
            const userAttribs = userInfo.UserAttributes;
            if (userAttribs && Array.isArray(userAttribs)) {
                $('#inputProfileEmail').val(userAttribs.find(a => a.Name === 'email').Value);
                $('#inputProfileFirstName').val(userAttribs.find(a => a.Name === 'given_name').Value);
                $('#inputProfileLastName').val(userAttribs.find(a => a.Name === 'family_name').Value);
                $('#inputProfileAppRole').val(userAttribs.find(a => a.Name === 'custom:appRole').Value);
                // const userTagsJson = userAttribs.find(a => a.Name === 'custom:userTags').Value;
                // if (userTagsJson) {
                //     $('#inputProfileUserTags').val(JSON.parse(userTagsJson));
                //     initializeUserTagsChips(userTagsJson);
                // }
            }
            const mfaSettings = userInfo.UserMFASettingList;
            if (mfaSettings && Array.isArray(mfaSettings)) {
                $('#mfaChoiceTOTP').prop('checked', mfaSettings.includes('SOFTWARE_TOKEN_MFA'));
                $('#mfaChoiceSMS').prop('checked', mfaSettings.includes('SMS_MFA'));
            }

            // fetch user tags
            getUserTags().then(({ userTags }) => {
                // console.log(userTags);
                // alert('Tags successfully fetched!');
                initializeUserTagsChips('chipsUserTags', 'inputUserChips', 'hiddenAwsUserTags', userTags);
            }
            ).catch(err => {
                console.log(err.responseText, status, err);
                alert('Oops, Tags could not be fetched!');
            });

            $('.config').hide();
            $('.authenticated').hide();
            $('.profile').removeAttr('hidden').show();

            M.updateTextFields();
        }).catch(e => {
            console.error(e);
            alert(`Uh-oh! Unable to get your profile info. Please login again and retry! <br/> (${e})`);
        });
    }

    function handleToggleMFA() {
        let mfaDesiredState  = $('#mfaChoiceTOTP')[0].checked ? 'enable' : 'disable';
        // getCognitoUserData().then(userInfo => { 
            // check if MFA preference is ever configured.
            // const mfaSettings = userInfo.UserMFASettingList;
            // if (!(mfaSettings && Array.isArray(mfaSettings))) { // && mfaSettings.length > 0)) {
            //     alert(`Okay, let's get MFA configured! <br/> Please scan the QR code or enter the secret code in your Authenticator app.`);
            //     $('#configureMFADetails').removeAttr('hidden');
            //     handleConfigureMFA();
            //     return;
            // } else {
                // if already configured, toggle state as desired.
                $('#configureMFADetails').hide();
                if (mfaDesiredState === 'disable') {
                    mfaDesiredState = mfaDesiredState && confirm(`Are you sure you'd like to turn OFF MFA?`);
                }
                // console.log('mfaDesiredState', mfaDesiredState);
                if (mfaDesiredState) {
                    changeMFAPreference(null, mfaDesiredState)
                        .then(message => {
                            console.log(message);
                            alert(`MFA is now turned ${(mfaDesiredState === 'enable' ? 'ON' : 'OFF')} !`);
                        })
                        .catch(e => {
                            console.error(e);
                            if (mfaDesiredState === 'enable' && e.code === 'InvalidParameterException') {
                                alert(`Okay, let's get MFA configured! <br/> Please scan the QR code or enter the secret code in your Authenticator app.`);
                                $('#configureMFADetails').removeAttr('hidden').show();
                                handleConfigureMFA();
                            } else {
                                alert(`Uh-oh! Problem attempting to ${mfaDesiredState} MFA state. <br/> ${e.message}`);
                            }
                        });
                }
        //     }
        // });
    }

    function handleConfigureMFA() {
        setupMfaTOTP().then(({secretCode, otpAuthURL}) => {
            // console.log({secretCode, otpAuthURL});
            $('#inputSecretCode').val(secretCode);
            M.updateTextFields();
            const typeNumber = 0;
            const errorCorrectionLevel = 'H';
            const qr = qrcode(typeNumber, errorCorrectionLevel);
            qr.addData(otpAuthURL);
            qr.make();
            const qrCodeImage = qr.createImgTag();
            // console.log('qrCodeImage', qrCodeImage);
            // document.getElementById('qrcodeCanvas').innerHTML = qr.createImgTag();
            $('#qrcodeCanvas').append(qrCodeImage);
        }).catch(e => {
            e.cancel = true;
            // console.error(e);
            alert(`<span>Uh-oh! Problem setting up MFA. <br/> <small>(${e.message})</small></span>`);
        });
    }

    function handleVerifyMFA() {
        const verifyCode = $('#inputProfileVerifyCode').val();
        verifyMFAToken(verifyCode, 'Google Authenticator').then((result) => {
            console.log('handleVerifyMFA', result);
            alert(`Great, your account is now protected with MFA. Please store your key securely!`);
        }).catch(e => {
            // console.error(e);
            alert(`<span>Uh-oh! Unable to verify using the code provided. Please check and retry. <br/><small>(${e.message})</small></span>`);
        });
    }
    
    function initializeUserTagsChips(chipsDivSelector, inputTagsSelector, hiddenInputSelector, userTagsJson = null) {
        const chipsElement = document.querySelector(`#${chipsDivSelector}`);
        const chipsDivJquery = $(`#${chipsDivSelector}`);
        const chipsInputJquery = $(`#${inputTagsSelector}`);
        const chipsUserTags = M.Chips.init(chipsElement, {
            placeholder: 'Enter a tag in format TagName = Value (e.g. Team = IT or Project = Portal)',
            secondaryPlaceholder: 'TagName = Value',
            limit: 5,
            // data: parseUserTags(userTagsJson),
            onChipAdd: (c, data) => {
                const MAX_TAGS_COUNT = 4, MAX_TAG_NAME_VAL_LEN = 20;
                const chipText       = data.childNodes[0].textContent;
                const allChips       = chipsUserTags.chipsData.map(c => c.tag);
                const tagIndex       = allChips.indexOf(chipText);
                const newChipParts   = chipText.split('=');
                
                let isValid = true;
                if (newChipParts.length !== 2) {
                    alert(`tag should be in the format: TagName = Value`);
                    isValid = false;
                } else {
                    const newTagName  = newChipParts[0].trim();
                    const newTagValue = newChipParts[1].trim();
                    
                    if(newTagName.startsWith('aws:')) {
                        alert(`tag names starting with aws: are reserved!`);
                        isValid = false;
                    }
                    if(newTagName.length > MAX_TAG_NAME_VAL_LEN || newTagValue.length > MAX_TAG_NAME_VAL_LEN) {
                        alert(`tag names and values should not exceed ${MAX_TAG_NAME_VAL_LEN} chars!`);
                        isValid = false;
                    }
                    if (allChips.filter(c => c.split('=')[0].trim() === newTagName).length > 1) {
                        alert(`tag name ${newTagName} already exists!`);
                        isValid = false;
                    } 
                }
                if (allChips.length > MAX_TAGS_COUNT) {
                    alert(`too many tags, max ${MAX_TAGS_COUNT}!`);
                    isValid = false;
                } 

                if (!isValid) {
                    // console.log('invalid', chipText, $('#inputUserChips').val());
                    chipsUserTags.deleteChip(tagIndex);
                    chipsDivJquery.val(chipText).trigger('focus');
                    buildUserTags(hiddenInputSelector, chipsUserTags.chipsData);
                    // return false;
                } else {
                    // console.log('VALID');
                    buildUserTags(hiddenInputSelector, chipsUserTags.chipsData);
                    chipsDivJquery.val('').removeClass('invalid');
                    // return true;
                }
            },
            onChipDelete: (c, d) => {
                // console.log('DELETED', chipsUserTags.chipsData, c, d);
                buildUserTags(hiddenInputSelector, chipsUserTags.chipsData);
            },
            onChipSelect: (c, data) => {
                const chipText = data.childNodes[0].textContent;
                const allChips = chipsUserTags.chipsData.map(c => c.tag);
                const tagIndex = allChips.indexOf(chipText);
                chipsUserTags.deleteChip(tagIndex);
                chipsDivJquery.val(chipText).focus();
            }
        });
        if (userTagsJson) {
            parseUserTags(userTagsJson).forEach(c => chipsUserTags.addChip(c));
        }
        // add chip on tab-out.
        chipsInputJquery.off('blur').on('blur', (e) => {
            const chipData = chipsInputJquery.val();
            chipsInputJquery.val(''); //.focus();
            chipsUserTags.addChip({
                tag: chipData
            });
        });
    }
    
    function buildUserTags(hiddenTagsSelector, chipsData) {
        // console.log(`: buildUserTags -> hiddenTagsSelector, chipsData`, hiddenTagsSelector, chipsData);
        const awsTagsFormat = chipsData.map(c => {
            const splitArray = c.tag.split('=');
                return {
                    Name: `tag:${splitArray[0].trim()}`,
                    Values: [ splitArray[1].trim() ]
                }
        });
        const awsTagsFormatString = JSON.stringify(awsTagsFormat);
        // console.log(awsTagsFormatString);
        $(`#${hiddenTagsSelector}`).val(awsTagsFormatString);
    }

    function parseUserTags(awsTagsFormatString) {
        const tagsArray = JSON.parse(awsTagsFormatString);
        // console.log(awsTagsFormatString, tagsArray, typeof tagsArray);
        const parsed = tagsArray.map(t => {
            return {
                name: t.Name.split('tag:')[1],
                values0: t.Values[0]
            }
        })
        .map(nv => { return { tag: `${nv.name} = ${nv.values0}` } })
        // console.log(awsTagsFormatString, parsed);
        return parsed;
    }

    async function getUserTags() {
        const apiBaseURL = getApiBaseURL(PubCloudAccountType);
        return requestData({
            method: 'GET',
            url: `${apiBaseURL}/users/${USER_NAME}/tags`,            
            contentType: 'application/json'
        });
    }

    async function handleUpdateUserTags(e) {
        e.preventDefault();
        if (!USER_ISADMIN) {
            alert(`<span class="text-warning">Only your Administrator can update assigned tags to your account profile.</span>`);
            e.cancel = true;
            return false;
        }
        try {
            const newTags = $('#hiddenAwsUserTags').val();
            const result  = await updateUserTags(newTags)
            console.log(`Tags update to Cognito`, result);
            // alert(result);
            await requestData({
                method: 'POST',
                url: `/users/${USER_NAME}/tags`,
                data: JSON.stringify({
                    username: USER_NAME,
                    userTags: newTags
                }),                
            }).catch(err => {
                console.error(err.responseText, status, err);
                alert('Uh-oh, unable to update the tags!');
            }).then(function ({ message }) {
                alert('Tags updated!');
            });
        } catch(reason) {
            console.error('handleUpdateUserTags', reason);
            alert(`Uh-oh, unable to update the tags! <br/> <small>(${reason})</small>`);
        }
    }

    const tenantConfigCloudsTableColumns = [
        {
            header: 'Name',
            column: 'Name'
        },
        {
            header: 'Account ID',
            column: 'AccountId'
        },
        {
            header: 'Type',
            column: 'AccountType',
            type: 'custom',
            template: ({ AccountType }) => {
                return getAccountTypeDisplay(AccountType);
            }
        },
        // {
        //     header: 'External ID',
        //     column: 'ExternalId'
        // },
        {
            header: 'Role ARN',
            column: 'RoleARN',
            type :  'custom',
            template: ({ AccountId, RoleARN, AccountType }) => {
                const {roleName, consolePath} = getRoleConsolePath(AccountId, RoleARN, AccountType);
                return `<a class='nav-iam-console' href='${consolePath}'  target='_blank'>${roleName}</a>`;
                // return `<a class="nav-iam-console" href="${consolePath}"  target="_blank">${roleName}</a>`;
            },
            optional: true
        },
        {
            header: 'Actions',
            column: '',
            type :  'actions',
            template: (jsonItem) => {
                const { Name, AccountId, ExternalID, RoleARN, AccountType} = jsonItem;
                return `
            <div class="btn-group">
                <button type="button" class="btn btn-secondary btn-sm dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false">
                    Actions
                </button>
                <div class="dropdown-menu" class="actions-menu">
                    <a class="dropdown-item" data-cloud='${JSON.stringify(jsonItem)}' data-action="editCloud"  href="#">Edit</a>
                    <a class="dropdown-item" data-account-id="${AccountId}" data-account-type="${AccountType}" data-action="deleteCloud" href="#">Delete</a>
                </div>
            </div>`
            }
        }
    ];
    
    const tenantConfigUsersTableColumns = [
        {
            header: 'User Name',
            column: 'username'
        },
        {
            header: 'Admin',
            column: '', //'isAdmin'
            type: 'custom',
            template: ({ isAdmin }) => {
                return isAdmin ? `<i class="material-icons">check_circle</i>` : `<i class="material-icons">not_interested</i>`
            }
        },
        {
            header: 'Enabled',
            column: '', //'enabled',
            type: 'custom',
            template: ({enabled}) => {
                return enabled ? `<i class="material-icons">check_circle</i>` : `<i class="material-icons">not_interested</i>`
            }
        },
        {
            header: 'Actions',
            column: '',
            type :  'actions',
            template: (jsonItem) => {
                const { username, isAdmin, enabled } = jsonItem;
                return `
            <div class="btn-group">
                <button type="button" class="btn btn-secondary btn-sm dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false">
                    Actions
                </button>
                <div class="dropdown-menu" class="actions-menu">
                    <a class="dropdown-item disabled" data-user='${JSON.stringify(jsonItem)}' data-action="editUser" href="#">Edit</a>
                    <a class="dropdown-item disabled" data-user='${JSON.stringify(jsonItem)}' data-action="deactivateUser" href="#">De-activate</a>
                </div>
            </div>`
            }
        }
    ];

    async function initializeTenantConfigInfo(e) {
        e && e.preventDefault();
        // const tenantConfigInfoEl = document.querySelector('#tenantConfigInfo');
        // const tenantConfigInfo = M.Collapsible.init(tenantConfigInfoEl, {
        //     accordion: true,
        //     // onOpenStart: (li) => {
        //     // }
        // });
        const clouds = await getClouds();
        const cloudsTableRows = renderTableRows(clouds, tenantConfigCloudsTableColumns);
        $('#tenantConfigCloudsTable').html(cloudsTableRows).show();

        const subscription = await getSubscription();
        const { tenantId, tenantStatus, registrationType, createdAt } = subscription;
        $('#hiddenTenantId').val(tenantId);
        $('#tenantSubscriptionCreatedAt').text(createdAt);
        $('#tenantSubscriptionStatus').text(tenantStatus);
        $('#tenantSubscriptionRegistration').text(registrationType);
        
        const users = await getUsers();
        const usersTableRows = renderTableRows(users, tenantConfigUsersTableColumns, 'Sorry, unable to fetch users list!');
        $('#tenantConfigUsersTable').html(usersTableRows).show();
    
        $('.profile').hide();
        $('.authenticated').hide();
        $('.config').removeAttr('hidden').show();
    }

    async function handleAddEditCloudsConnection(e, onlyTestConnection = false, mode = 'addCloud' || 'editCloud') {
        e.preventDefault();

        const { isValid, cloudData, cloudRow } = validateCloudConnection();
        if (!isValid) return false;

        const isGovCloud = $('#inputTenantAccountType').is(':checked');
        const accountType = isGovCloud ? GovCloudAccountType : PubCloudAccountType;

        const {connectionValid, message, tenantId, accountId} = await requestData({
            method: 'POST',
            url: `/registration/connectclouds/auth?test=${onlyTestConnection}&mode=${mode}`,            
            data: JSON.stringify(cloudData),
            apiContext: accountType
        });
        
        if (!connectionValid) {
            console.error(message);
            alert(`Uh-oh, there seems to be a problem connecting to your account. Please check and retry! <br/> ( <small>${message}</small> )`);
            return false;
        }
        if (onlyTestConnection) {
            alert('Cloud connection looks good! <br/> Please Save and proceed.');
            return true;
        }
        alert('Cloud connection successfully saved!');
        // $('#tenantConfigCloudsTable')
        //     .append(cloudRow)
        //     .parent().removeAttr('hidden');

        await initializeTenantConfigInfo();
        
        $('#editTenantConfigCloudsModal').modal('hide');
    }

    async function handleDeleteCloudsConnection(accountId, accountType) {
        console.log(`: handleDeleteCloudsConnection -> accountId, accountType`, accountId, accountType);
        try {
            const { message } = await requestData({
                method: 'DELETE',
                url: `/clouds/${accountId}`,
                apiContext: accountType
            });
            alert(message);
            await initializeTenantConfigInfo();
        } catch (err) {
            console.error(`: handleDeleteCloudsConnection -> err`, err);
            // console.log(err.responseText, status, err);
            alert(`Cloud connection delete failed - ${err}`);
        }
    }

    function handleCloudConnectionAction(e) { // handles menu actions (Edit or Delete) for a cloud row
        // if ($(e.target).hasClass('nav-iam-console')) return; // navigate to role in IAM Console
        e.preventDefault();
        const action = $(e.target).attr('data-action');
        const cloud = $(e.target).attr('data-cloud');
        
        if (action === 'editCloud' && cloud) {
            const { Name,  AccountId, ExternalId, RoleARN } = JSON.parse(cloud)
            initializeCloudsForm({ mode: 'editCloud', Name,  AccountId, ExternalId, RoleARN });
        } else if (action === 'deleteCloud') {
            const accountId = $(e.target).data('account-id');
            const accountType = $(e.target).data('account-type');
            if (confirm(`Are you sure you want to delete the cloud with Account ID ${accountId}`)) {
                handleDeleteCloudsConnection(accountId, accountType);
                // alert(`Cloud connection for Account ID ${accountId} deleted.`);
            }
        }
    }

    function initializeCloudsForm({mode, Name,  AccountId, ExternalId, RoleARN, AccountType}) {
        $('#createCloudsForm').trigger('reset').off('submit').on('submit', (e) => {
            handleAddEditCloudsConnection(e, false, mode);
        });
        $('#testCloudAccountAccess').off('click').on('click', (e) => {
            handleAddEditCloudsConnection(e, true, mode);
        });

        $('#setupCloudAccountAccess').off('click').on('click', (e) => {
            const cloudName    = $('#inputConnectionName').val();
            const cloudAccount = $('#inputTenantAccount').val();
            const externalId   = $('#inputExternalID').val();
            const isGovCloud   = $('#inputTenantAccountType').is(':checked');
            const accountType  = isGovCloud ? GovCloudAccountType : PubCloudAccountType;
            
            const proceed = confirm(`You will be redirected to login to AWS CloudFormation in your account (${cloudAccount}).\nPlease complete the Role Policy setup and resume back here.`);
            if (proceed) {
                const cloudFormationURL = getCloudFormationURL(externalId, cloudName, accountType);
                window.open(cloudFormationURL);
            }
        });
        
        $('#inputTenantAccountType').off('change').on('change', (e) => {
            const isGovCloud = $('#inputTenantAccountType').is(':checked');
            const accountType = isGovCloud ? GovCloudAccountType : PubCloudAccountType;
            const hostingAccountId = getHostingAccount(accountType);
            $('#inputHostingAccount').val(hostingAccountId);  // pre-populate the hosting account
        });

        if (mode === 'addCloud') {
            
            $('#editTenantConfigCloudsModalHeader').text('Add New Cloud Connection');
            $('#editTenantConfigCloudsNote').attr('hidden', true).hide();
            $('#inputExternalID').val(uuidv4());
            $('#inputTenantAccountType').prop('checked', false).trigger('change');

        } else if (mode === 'editCloud') {

            $('#editTenantConfigCloudsModalHeader').text('Edit Cloud Connection');
            $('#editTenantConfigCloudsNote').removeAttr('hidden').show();
            $('#inputConnectionName').val(Name);
            $('#inputTenantAccount').val(AccountId);
            $('#inputCrossAccountRoleARN').val(RoleARN);
            $('#inputExternalID').val(ExternalId);

            const isGovCloud = AccountType === GovCloudAccountType;
            $('#inputTenantAccountType').prop('checked', isGovCloud).trigger('change');;
        }

        $('#inputRolePolicy').text(rolePolicy);
        M.updateTextFields();

        $('#editTenantConfigCloudsModal').modal(
        {
            show: true,
            backdrop: 'static',
            keyboard: true
        });
        
    }
    
    function validateCloudConnection() {
        let isValid = true;

        const cloudName   = $('#inputConnectionName').val().trim();
        const externalId  = $('#inputExternalID').val();
        const accountId   = $('#inputTenantAccount').val();
        const roleARN     = $('#inputCrossAccountRoleARN').val().trim();
        const cloudRow    = `<tr><th scope="row">${cloudName}</th><td>${accountId}</td><td>${externalId}</td></tr>`;
        const isGovCloud  = $('#inputTenantAccountType').is(':checked');
        const accountType = isGovCloud ? GovCloudAccountType : PubCloudAccountType;

        const cloudData = {
            cloudName,
            accountId,
            externalId,
            roleARN,
            accountType,
            // tenantId: TENANT_ID
        };
        // console.log(cloudData);
        
        if (!roleARN || !(roleARN.startsWith(`arn:aws:iam::${accountId}:role/`) || roleARN.startsWith(`arn:aws-us-gov:iam::${accountId}:role/`))) {
            $('#inputCrossAccountRoleARN').addClass('invalid');
            isValid = false;
        }
        else {
            $('#inputCrossAccountRoleARN').removeClass('invalid');
        }
        return { isValid, cloudData, cloudRow };
    }

    function initializeInviteNewUserForm(e) {
        e.preventDefault();
        $('#add-people-template-lead').text('Invite a new user to the team...');
        M.updateTextFields();

        $('#inputEmailVerify, #inputPasswordVerify, #inputEmail, #inputPassword')
            .on('blur change', () => validatePeopleForm(true));

        // initialize the Chips component for User Tags
        initializeUserTagsChips('chipsNewUserTags', 'inputNewUserChips', 'hiddenAwsNewUserTags');
        $('#inviteNewUserForm').trigger('reset');

        $('#editTenantConfigTeamModal').modal(
            {
                show: true,
                backdrop: 'static',
                keyboard: true
            }
        );
    }

    function validatePeopleForm(validateEmailPasswordOnly = false) {

        let isValid = true;
        if ($('#inputPassword').val() !== $('#inputPasswordVerify').val()) {
            // alert(`passwords don't match!`);
            $('#inputPasswordVerify').addClass('invalid');
            isValid = false;
        } else {
            $('#inputPasswordVerify').removeClass('invalid');
        }
        if ($('#inputEmail').val() !== $('#inputEmailVerify').val()) {
            // alert(`emails don't match!`);
            $('#inputEmailVerify').addClass('invalid');
            isValid = false;
        } else {
            $('#inputEmailVerify').removeClass('invalid');
        }
        // console.log('validating user form...', isValid);
        if (!isValid || validateEmailPasswordOnly) {
            return { isValid };
        }

        const tenantId  = $('#hiddenTenantId').val();
        const firstName = $('#inputFirstName').val();
        const lastName  = $('#inputLastName').val();
        const userEmail = $('#inputEmail').val();
        const appRole   = $('input[name=inputUserRole]:checked').val();
        const password  = $('#inputPassword').val();
        const userTags  = $('#hiddenAwsNewUserTags').val();

        let userRow;

        // console.log(userEmail, password, firstName, lastName, appRole, TENANT_ID, userTags);
        // if (!TENANT_ID) {
        //     alert(`We're sorry, looks like something went wrong! <br/> Please restart the registration.`);
        //     return { isValid: false };
        // }

        const userTagsMalformed = `Oops! User Tags appear to be missing or malformed. <br/> Please check & retry.`;
        try {
            const userTagsParsed = JSON.parse(userTags); // console.log(userTagsParsed); 
            if (userTagsParsed.length && userTagsParsed.length > 0) {
                isValid = true;
                userRow = `<tr><th scope="row">${userEmail}</th><td>${firstName} ${lastName}</td><td>${appRole}</td><td>${parseUserTags(userTags)}</td></tr>`;
            } else {
                alert(userTagsMalformed);
                return { isValid: false };
            }
        } catch (e) {
            // console.error(userTagsMalformed, userTags, e);
            alert(userTagsMalformed);
            return { isValid: false };
        }

        return {
            isValid,
            userFormData: { userEmail, password, firstName, lastName, appRole, tenantId, userTags },
            userRow
        };
    }

    function handleInviteNewUserFormSubmit(e) {
        e && e.preventDefault();
        console.log(`: handleInviteNewUserFormSubmit -> e`, e);

        const { isValid, userFormData, userRow } = validatePeopleForm(false);
        console.log(`: handleInviteNewUserFormSubmit -> isValid, userFormData`, isValid, userFormData);
        if (!isValid) return false;

        userSignUp(userFormData)
            .then(({ firstName, userEmail }) => {
                alert(`User account for ${firstName} created! <br/> Verification code sent to ${userEmail}.`);
                $('#inviteNewUserForm').trigger('reset');
                $('#editTenantConfigTeamModal').modal('hide');
            })
            .catch(e => {
                console.error('Problem creating Cognito user', e);
                alert(`<span>Uh-oh! We've hit a problem setting up the user account. Please check and retry. <br/> <small>(${e.message})</small></span>`);
            });
    }

    function renderCollection(jsonItems, sortField, sortOrder, itemTemplate, containerDiv, fixDivHeight = '150px') {
        // console.log('renderCollection', jsonItems, sortField, itemTemplate, containerDiv, fixDivHeight);
        const collectionContent = createCollectionContent(jsonItems, sortField, sortOrder, itemTemplate, fixDivHeight);
        $(`#${containerDiv}`)
            .html('')
            .append(collectionContent);
        updateCounters();
    }

    function createCollectionContent(jsonItems, sortField, sortOrder, itemTemplate, fixDivHeight) {
        if (sortField) {
            sortOrder = sortOrder && Number.isInteger(sortOrder) && sortOrder > 0 ? 1 : -1;
            jsonItems = jsonItems.sort((x, y) => x[sortField] > y[sortField] ? sortOrder : -1 * sortOrder);
        }
        const items = jsonItems.map(jsonItem => itemTemplate(jsonItem)).join('');
        const collectionContent = `<div style="max-height:${fixDivHeight}">
                <ul class="collection" style="max-height:${fixDivHeight}; overflow-y: auto; border:none!important">
                    ${items}
                </ul>
            </div`;
        return collectionContent;
    }

    const workflowItemTemplate = ({workflowName, workflowId, workflowEnabled, resourceType}) => {
        return `
            <li class="collection-item" style="height: 150px;">
                <div class="row">
                    <div class="col">
                        <span>
                        <strong class="text-dark">${workflowName}</strong>
                        <br/>
                        <em class="text-small">(${resourceType})</em>
                        </span>
                    </div>
                </div>
                <div class="row">
                    <div class="col-md-3 m-1">
                        <span class="switch">
                            <label>
                                <input type="checkbox" class="workflow-action" data-action="changeWorkflowState" data-workflow-id="${workflowId}" data-workflow-name="${workflowName}" 
                                ${workflowEnabled ? 'checked' : ''}>
                                <span class="lever text-dark" data-toggle="tooltip" data-placement="bottom" title="${workflowEnabled ? 'Disable' : 'Enable'}"></span>
                            </label>
                        </span>
                    </div>
                    <div class="col-md-2">
                        <i class="small material-icons workflow-action text-dark" style="cursor: pointer;"
                            data-action="editWorkflow" data-workflow-id="${workflowId}" data-workflow-name="${workflowName}"
                            data-toggle="tooltip" data-placement="bottom" title="Edit Workflow">edit</i>
                    </div>
                    <div class="col-md-2">
                        <i class="small material-icons workflow-action text-dark" style="cursor: pointer;" 
                            data-action="copyWorkflow" data-workflow-id="${workflowId}" data-workflow-name="${workflowName}"
                            data-toggle="tooltip" data-placement="bottom" title="//TODO: Copy Workflow">file_copy</i>
                    </div>
                    <div class="col-md-2">
                        <i class="small material-icons workflow-action text-dark" style="cursor: pointer;" 
                            data-action="deleteWorkflow" data-workflow-id="${workflowId}" data-workflow-name="${workflowName}"
                            data-toggle="tooltip" data-placement="bottom" title="Delete Workflow">delete</i>
                    </div>
                </div>
                <hr/>
            </li>`;
    };

    async function getWorkflowsList() {
        try {
            let workflows = await getSavedWorkflows();

            if (!workflows || workflows.length === 0) {
                $('#workflowsInfoTable').html(`<span class="text-warning">No workflows created for this cloud & region!</span>`);
                return;
            }
            workflows = workflows.map(wf => { return { ...wf, workflowEnabled: wf.workflowStatus === 'ACTIVE' } });
            //- console.table(workflows);
            renderCollection(workflows, 'createdAt', 1, workflowItemTemplate, 'workflowsInfoTable', '600px');
            $('#workflowsInfoTable [data-toggle="tooltip"]').tooltip();

            // if ($('#selectSavedWorkflows').val()) {
            //     if (confirm(`Are you sure you'd like to reset your selections?`)) {
            resetWorkflowRequestForm();
            //     } else {
            //         return false;
            //     }
            // }
            if (!workflows || workflows.length === 0) {
                $('#selectSavedWorkflows').html('').append(`<option value="" disabled selected>No workflows created for this cloud & region!</option>`).formSelect();
                return;
            }
            workflows = workflows.filter(wf => wf.workflowEnabled);

            const resourceTypes = new Set(workflows.map(wf => wf.resourceType));
            const optGroups = Array.from(resourceTypes)
                .sort((wf1, wf2) => wf1.resourceType > wf2.resourceType ? -1 : 1)
                .map(rt => {
                    return `<optgroup label="Resource Type: ${rt}">
                    ${
                        workflows.filter(wf => wf.resourceType === rt)
                            .map(wf => `<option value="${wf.workflowId}${!wf.workflowEnabled ? ' disabled' : ''}">${wf.workflowName}${!wf.workflowEnabled ? ' (disabled)' : ''}</option>`)
                            .join('')
                        } 
                    </optgroup>`;
                }).join('');
            $('#selectSavedWorkflows')
                .off('change').on('change', handleSelectWorkflow)
                .html('').append('<option value="0" disabled selected>Select workflow to submit a new request</option>').append(optGroups)
                .formSelect();
        } catch (err) {
            console.error(err);
            $('#workflowsInfoTable').html(`<span class="text-danger">Oops! Unable to fetch workflows for this cloud & region!</span>`);
            $('#selectSavedWorkflows').html(`<span class="text-danger">Oops! Unable to fetch workflows for this cloud & region!</span>`);
        }
    }

    async function getSavedWorkflows() {
        return await requestData({
            method: 'GET',
            url: `/clouds/AWS_ACCOUNT_ID/regions/REGION/workflows`,
        });
    }

    function handleWorkflowAction(e) {
        // e.preventDefault();
        const actionLink   = $(e.target);
        const action       = actionLink.attr('data-action');
        const workflowId   = actionLink.attr('data-workflow-id');
        const workflowName = actionLink.attr('data-workflow-name');
        // alert(`executing ${action} for ${workflowId} ...`);
        if (action === 'editWorkflow') {
            if(confirm(`Discard any changes and edit the existing workflow - ${workflowName} ?`)) {
                getWorkflowInfo(workflowId, false)
                    .then((workflow) => {
                        if (!workflow) {
                            alert(`Oops! Unable to edit the selected workflow. Please refresh the workflow list.`);
                            return;
                        }
                        console.log(workflow);
                        const { resourceType } = workflow;
                        
                        // first load all default params by triggering a resource type change
                        // passing in the callback argument to bind the workflow asynchronously
                        $('#inputResourceType')
                            .val(resourceType)
                            .trigger('change', [(wf) => bindWorkflow(wf), workflow]) // arguments for  
                            .formSelect();

                        showWorkflowSections(resourceType);

                    }).catch(err => {
                        console.error(err);
                        alert(`Oops! Unable to edit the selected workflow. Please refresh the workflow list.`);
                        return;
                    });
            }
        } else if (action === 'deleteWorkflow') {
            if(confirm(`Are you sure you'd like to delete this workflow - ${workflowName} ?`)) {
                deleteWorkflow(workflowId)
                    .then(deletedMessage => {
                        alert(`Workflow deleted!`);
                        getWorkflowsList();
                    }).catch(err => {
                        console.error(err);
                        alert(`Uh-oh! we were unable to delete the workflow!`);
                    });
            }
        } else if (action === 'changeWorkflowState') {
            const enabled = $(e.target).is(':checked');
            // console.log('handleWorkflowAction', enabled);
            // changeWorkflowState(workflowId, enabled)
            //     .then(updated => {
                    alert(`//TODO: Workflow ${workflowName} ${enabled ? 'enabled': 'disabled'}`);
                // });
        }
    }

    function getWorkflowInfo(workflowId, includeDetails = false) {
        return requestData({
            method: 'GET',
            url: `/clouds/AWS_ACCOUNT_ID/regions/REGION/workflows/${workflowId}?details=${includeDetails}`,
        });
    }

    function bindWorkflow(workflow) {
        const {
            workflowId,
            workflowStatus,
            workflowName,
            resourceType,
            autoAssignIpAddress,
            vpcs,
            subnets,
            securityGroups,
            images,
            instanceTypes,
            keyPairs,
            imageList,
            leaseOptions : {
                applyLease = false,
                leaseAction,
                leaseDuration,
                leaseDurationUnit    
            } = {},
            volumeTypes,
            storageOptions: {
                maxVolumeCount,
                deleteOnTermination = true,
                encryption: {
                    enabled = false,
                    key
                } = {},
            } = {},
            bundles,
            approvers,
            workspaceOptions: {
                runningMode = 'runningmode-alwayson',
                autoStopHours
            } = {}
        } = workflow;

        console.log('bindWorkflow', resourceType, workflow);

        $('#inputWorkflowId').val(workflowId);
        $('#inputWorkflowStatus').val(workflowStatus);
        $('#inputWorkflowName').val(workflowName);
        // $('#inputResourceType').val(resourceType).trigger('change', ['noReloadParams']).formSelect();
        
        if (resourceType === 'EC2') {
            $('#autoAssignIpAddress').prop('checked', autoAssignIpAddress);
            bindArrayToCheckboxes(vpcs,'ec2ParamsVpcsTable');
            bindArrayToCheckboxes(subnets,'ec2ParamsSubnetsTable');
            bindArrayToCheckboxes(securityGroups,'ec2ParamsSecurityGroupsTable');
            bindArrayToCheckboxes(instanceTypes,'ec2ParamsInstanceTypesTable');
            bindArrayToCheckboxes(keyPairs,'ec2ParamsKeyPairsTable');
            // bindArrayToCheckboxes(images,'ec2ParamsImagesTable');
            $('#inputEc2ParamsImageList').val(images.join(','));
            $('#resolveEc2ImageList').trigger('click');

            $('#deleteTermination').prop('checked', deleteOnTermination);
            $('#encryptVolumes').prop('checked', enabled);
            $('#encryptVolumeKeys').val(key).formSelect();
            $('#maxVolumeCount').prop('disabled', false).val(maxVolumeCount);

            bindLeaseSection({applyLease, leaseAction, leaseDuration, leaseDurationUnit});

            if (volumeTypes && volumeTypes.length > 0) {
                $('#allowVolumes').prop('checked', true); //.trigger('change');
                $('#ec2ParamsStorageTable').show();
                volumeTypes.forEach(({ volumeTypeCode, size, iops }) => {
                    bindArrayToCheckboxes([volumeTypeCode], 'ec2ParamsStorageTable');
                    setSliderValues({ marker: `size_${volumeTypeCode}`, values: size });
                    if (iops) {
                        setSliderValues({ marker: `iops_${volumeTypeCode}`, values: iops });
                    }
                });
            }
        } else if (resourceType === 'WorkSpaces') {
            // console.log('binding ws', bundles, runningMode, autoStopHours);
            $(`#paramsRunningModeOptionList input[name=paramsRunningModeOptions][value="${runningMode}"]`).prop('checked', true);
            if(runningMode === 'runningmode-autostop') {
                $('#runningModeAutoStopHours').val(autoStopHours) 
            };

            // bindArrayToCheckboxes(bundles,'workspacesParamsBundlesTable');
            $('#inputworkspacesBundleList').val(bundles.join(','));
            $('#resolveWorkspacesList').trigger('click');
        }
        bindArrayToCheckboxes(approvers,'paramsApproversTable');
        M.updateTextFields();
    }

    function bindArrayToCheckboxes(array, containerDiv, marker = '') {
        if (!array || !Array.isArray(array)) return;
        array.forEach(a => {
            const id = marker ? marker + '_' + a : a;
            const selector = `#${containerDiv} input[type="checkbox"][id="${id}"]`;
            $(selector).prop('disabled', false).prop('checked', true).trigger('change');
        });
    }

    function bindLeaseSection({applyLease, leaseAction, leaseDuration, leaseDurationUnit}) {
        // console.log(`: bindLeaseSection -> applyLease, leaseAction, leaseDuration, leaseDurationUnit`, applyLease, leaseAction, leaseDuration, leaseDurationUnit);
        $('#applyLease').prop('checked', applyLease);
        $('#leaseAction').val(leaseAction || "0").prop('disabled', !applyLease).formSelect();
        $('#leaseDuration').prop('disabled', !applyLease).val(leaseDuration || 1);
        $('#leaseDurationUnit').val(leaseDurationUnit || "0").prop('disabled', !applyLease).formSelect();
    }

    function deleteWorkflow(workflowId) {
        return requestData({
            method: 'DELETE',
            url: `/clouds/AWS_ACCOUNT_ID/regions/REGION/workflows`,
            data: JSON.stringify({ workflowId })
        });
    }

    async function handleLoadWorkflowParams(e, bindWorkflowCallback = null, workflow = null) {
        // console.log('handleLoadWorkflowParams', !!bindWorkflowCallback, !!workflow);
        const resourceType = $('#inputResourceType').val();
        if (!resourceType) {
            hideWorkflowSections();
            return false;
        }
        try {
            // const workflowParams = await getWorkflowParams(resourceType);
            let [workflowParams, approvers] = await Promise.all([getWorkflowParams(resourceType), getUsers()]);
            showWorkflowSections(resourceType);
            $('#inputWorkflowId').val('');
            $('#inputWorkflowName').val('');
            M.updateTextFields();

            if (resourceType === 'EC2') {
                const { vpcs, subnets, securityGroups, instanceTypes, keyPairs } = workflowParams;
                renderCollection(vpcs, 'CidrBlock', 1, ec2ParamsVpcsItemTemplate, 'ec2ParamsVpcsTable');
                renderCollection(subnets, 'CidrBlock', 1, ec2ParamsSubnetsItemTemplate, 'ec2ParamsSubnetsTable');
                renderCollection(securityGroups, 'VpcId', 1, ec2ParamsSecurityGroupsItemTemplate, 'ec2ParamsSecurityGroupsTable');
                renderCollection(instanceTypes, 'instanceType', 1, ec2ParamsInstanceTypesItemTemplate, 'ec2ParamsInstanceTypesTable');
                renderCollection(keyPairs, 'KeyName', 1, ec2ParamsKeyPairsItemTemplate, 'ec2ParamsKeyPairsTable');
                renderCollection([], ec2ParamsImageListItemTemplate, 'ec2ParamsImagesTable');
                $('#inputEc2ParamsImageList').val('');
                $('.item-check-vpc').off('change').on('change', handleVpcChange);
                $('.item-check-subnet, .item-check-securitygroup, .item-check-instancetype, .item-check-image, .item-check-keypair').off('change').on('change', updateCounters);

                initializeStorageOptionSliders();
                $('.item-check-volumetype').off('change').on('change', updateCounters);

                bindLeaseSection({ applyLease: false });

            } else if (resourceType === 'WorkSpaces') {
                const { awsBundles, userBundles } = workflowParams;
                $('#inputEc2ParamsImageList').val('');
                // renderCollection(awsBundles, 'Name', 1, workspaceParamsBundleItemTemplate, 'workspacesParamsBundlesTable');
                // $('.item-check-bundle').off('change').on('change', updateCounters);
            }

            // let approvers = await getUsers(); 
            approvers = approvers.map(app => { return { userId: app.username, ...app } });
            approvers.push({ userId: 'auto-approve', username: 'Auto-Approve?', isAdmin: false, isAutoApprove: true });
            console.log(`:: handleLoadWorkflowParams -> approvers`, approvers);
            renderCollection(approvers, '', 1, approversItemTemplate, 'paramsApproversTable');
            // $('#minApproversCount').attr('max', approvers.length);

            $('#paramsApproversTable input[type="checkbox"][data-auto-approve="true"]').on('change', (e) => {
                if ($(e.target).is(':checked')) {
                    $('#paramsApproversTable input[type="checkbox"]:not([data-auto-approve])').prop('checked', false);
                    $('#paramsApproversOptionsList input').prop('disabled', true);
                }
            });
            $('#paramsApproversTable input[type="checkbox"]:not([data-auto-approve="true"])').on('change', (e) => {
                if ($(e.target).is(':checked')) {
                    $('#paramsApproversTable input[type="checkbox"][data-auto-approve]').prop('checked', false);
                    $('#paramsApproversOptionsList input').prop('disabled', false);
                }
            });
            $('.item-check-user').on('change', updateCounters);

            updateCounters();

            if (bindWorkflowCallback) {
                console.log('bindWorkflowCallback', workflow);
                bindWorkflowCallback(workflow);
            }
        } catch (err) {
            console.error(err);
            alert(`<span>Oops! there was a problem setting up parameters for the requested resource (${resourceType}). <br/> <small>(${err.responseJSON.message})</small> </span>`);
            hideWorkflowSections();
        }
    }

    function hideWorkflowSections() {
        $('#createWorkflowForm *.workflow-params').hide();
        $('#createWorkflowForm *.workflow-params.params-all').hide();
    }

    function showWorkflowSections(resourceType) {
        $('#createWorkflowForm *.workflow-params').hide();
        $(`#createWorkflowForm li.workflow-params.params-${resourceType.toLowerCase()}`).show();
        $('#createWorkflowForm *.workflow-params.params-all').show();
    }

    function getWorkflowResourceTypes() {
        return requestData({
            method: 'GET',
            url: `/clouds/AWS_ACCOUNT_ID/regions/REGION/workflows/params/resourceTypes`,
        });
    }

    async function getWorkflowParams(resourceType) {
        return await requestData({
            method: 'GET',
            url: `/clouds/AWS_ACCOUNT_ID/regions/REGION/workflows/params/${resourceType}`,
        });
    }
    
    const volumeTypeConfigs = [
        {
            volumeTypeName: "General Purpose SSD",
            volumeTypeCode: "gp2",
            volumeSizeMinGB: 1,
            suggestedSizeGB: 5000,
            volumeSizeMaxGB: 16384 ,
            provisionedIOPS: false,
            minIOPS: (volumeSize) => Math.max(Math.min(3 * volumeSize, 100), 16000),
            maxIOPS: null,
        }, 
        {
            volumeTypeName: "Provisioned IOPS SSD",
            volumeTypeCode: "io1",
            volumeSizeMinGB: 4,
            suggestedSizeGB: 5000,
            volumeSizeMaxGB: 16384 ,
            provisionedIOPS: true,
            minIOPS: 100,
            maxIOPS: 64000,
        }, 
        {
            volumeTypeName: "Cold HDD",
            volumeTypeCode: "sc1",
            volumeSizeMinGB: 500,
            suggestedSizeGB: 2000,
            volumeSizeMaxGB: 16384 ,
            provisionedIOPS: false,
            minIOPS: null,
            maxIOPS: null,
        },
        {
            volumeTypeName: "Throughput Optimized HDD",
            volumeTypeCode: "st1",
            volumeSizeMinGB: 500,
            suggestedSizeGB: 5000,
            volumeSizeMaxGB: 16384 ,
            provisionedIOPS: false,
            minIOPS: null,
            maxIOPS: null,
        },
        {
            volumeTypeName: "Magnetic",
            volumeTypeCode: "standard",
            volumeSizeMinGB: 1,
            suggestedSizeGB: 500,
            volumeSizeMaxGB: 1024 ,
            provisionedIOPS: false,
            minIOPS: null,
            maxIOPS: null,
        },
    ];

    const volumeTypeConfigHeaders = [
        'Storage Type',
        'Device',
        'Snapshot',
        'Volume Type',
        'Size / IOPS',
        'Throughput',
        'Options',
        [
            'Delete on termination', 'Encryption'
        ],
    ];
    

    const volumeTypeConfigItemTemplate = ({ volumeTypeCode, volumeTypeName, provisionedIOPS }) => {

        const volumeConfigRow = `
        <div class="row">
            <div class="col-md-3">
                <p>
                    <label>
                        <input type="checkbox" class="item-check-volumetype filled-in" 
                            id="${volumeTypeCode}"
                            value="${volumeTypeCode}" 
                        />
                        <span class="text-small">${volumeTypeName} (${volumeTypeCode})</span>
                    </label>
                </p>
            </div>
            <div class="col-md-5">
                <label>Size:</label>
                <br/>
                <div class="input-small" id="size_${volumeTypeCode}"></div>
                ${
                    provisionedIOPS 
                    ? `<br/>
                    <label>IOPS:</label>
                    <br/>
                    <div id="iops_${volumeTypeCode}"></div>`
                    : ''
                }
            </div>
            <div class="col-md-2">
                <input class="input-small" type="number" id="min_size_${volumeTypeCode}" 
                    data-volumetype-code="${volumeTypeCode}"/>
                ${
                    provisionedIOPS 
                    ? `<br/>
                    <input class="input-small" type="number" id="min_iops_${volumeTypeCode}" 
                        data-volumetype-code="${volumeTypeCode}" />
                    <br/>`
                    : ''
                }
            </div>
            <div class="col-md-2">
                <input class="input-small" type="number" id="max_size_${volumeTypeCode}" 
                    data-volumetype-code="${volumeTypeCode}"/>
                ${
                    provisionedIOPS 
                    ? `<br/>
                    <input class="input-small" type="number" id="max_iops_${volumeTypeCode}" 
                        data-volumetype-code="${volumeTypeCode}" />
                    <br/>`
                    : ''
                }
            </div>
        </div>
        <hr/>`;

        return volumeConfigRow;
    }

    function setSliderValues({ marker, values }) {
        const slider = document.getElementById(marker);
        slider.noUiSlider.set(values);
    }
    
    function initializeStorageOptionSliders() {
        const volumeOptions = createCollectionContent(volumeTypeConfigs, '', null, volumeTypeConfigItemTemplate, '550px');
        $('#ec2ParamsStorageTable')
            .html(volumeOptions)
            .prepend(
                `<span class="text-small">Select allowed volume types and configurations (min - max range)</span><hr/>`
            );
        $('#allowVolumes').prop('checked', false).trigger('change');

        volumeTypeConfigs.forEach(({
            volumeTypeCode, 
            volumeSizeMinGB, suggestedSizeGB, volumeSizeMaxGB,
            provisionedIOPS, minIOPS, maxIOPS 
        }) => {
            initializeSlider({ marker:`size_${volumeTypeCode}`,  min: volumeSizeMinGB, top: suggestedSizeGB, max: volumeSizeMaxGB });
            if(provisionedIOPS) {
                initializeSlider({ marker:`iops_${volumeTypeCode}`,  min: minIOPS, top: 1000, max: maxIOPS });
            }
        });
    }

    function initializeSlider({ marker, min, top, max }) {
        const slider = document.getElementById(marker);
        noUiSlider.create(slider, {
            start: [min, top],
            connect: true,
            step: 1,
            orientation: 'horizontal', // 'horizontal' or 'vertical'
            range: {
                min: min,
                max: max
            },
            format: wNumb({
                decimals: 0,
                // suffix: '(GiB)'
            }),
            tooltips: [true, true],
        });
        slider.noUiSlider.on('update', (values, handle) => {
            $(`#min_${marker}`).val(values[0]);
            $(`#max_${marker}`).val(values[1]);
        });
    }

    async function handleSaveWorkflow(e) {
        e.preventDefault();
        const { workflowIsValid, message } = validateWorkflow();
        if (!workflowIsValid) {
            alert(message);
            return false;
        }
        const workflowId     = $('#inputWorkflowId').val();
        const workflowStatus = $('#inputWorkflowStatus').val();
        const workflowName   = $('#inputWorkflowName').val();
        const resourceType   = $('#inputResourceType').val();
        const selectedItems  = getSelectedParamItems();
        
        let workflowParams;
        if (resourceType === 'EC2') {
            const autoAssignIpAddress = $('#autoAssignIpAddress').is(':checked');
            const applyLease          = $('#applyLease').is(':checked');
            const leaseAction         = $('#leaseAction').val();
            const leaseDuration       = $('#leaseDuration').val();
            const leaseDurationUnit   = $('#leaseDurationUnit').val();
            const deleteOnTermination = $('#deleteTermination').is(':checked');
            const encryptionEnabled   = $('#encryptVolumes').is(':checked');
            const encryptionKey       = $('#encryptVolumeKeys').val();
            const allowVolumes        = $('#allowVolumes').is(':checked');
            const maxVolumeCount      = $('#maxVolumeCount').val();

            workflowParams      = {
                autoAssignIpAddress,
                vpcs          : selectedItems.vpcs.get().map(x => x.value),
                subnets       : selectedItems.subnets.get().map(x => x.value),
                securityGroups: selectedItems.securityGroups.get().map(x => x.value),
                images        : selectedItems.images.get().map(x => x.value),
                instanceTypes : selectedItems.instanceTypes.get().map(x => x.value),
                keyPairs      : selectedItems.keyPairs.get().map(x => x.value),
                leaseOptions  : {
                    applyLease,
                    leaseAction,
                    leaseDuration,
                    leaseDurationUnit
                },
                volumeTypes   : allowVolumes ? getVolumeTypes(selectedItems.volumeTypes) : null,
                storageOptions: {
                    maxVolumeCount: allowVolumes && maxVolumeCount && parseInt(maxVolumeCount),
                    deleteOnTermination,
                    encryption: {
                        enabled: encryptionEnabled,
                        key    : encryptionKey
                    },
                }
            };
        } else if (resourceType === 'WorkSpaces') {
            const runningMode   = $('#paramsRunningModeOptionList input[name=paramsRunningModeOptions]:checked').val();
            const autoStopHours = (runningMode === 'runningmode-autostop' ? $('#runningModeAutoStopHours').val() : undefined);
            workflowParams = {
                bundles  : selectedItems.bundles.get().map(x => x.value),
                workspaceOptions : {
                    runningMode,
                    autoStopHours
                }
            }
        }

        const approvers = selectedItems.approvers.get().map(x => x.value);
        const approvalOption = $('#paramsApproversOptionsList input[name=paramsApproversOptions]:checked').val();
        const approversCount = (approvalOption === 'approve-minx') ? $('#minApproversCount').val() : undefined;
        const approvalOptions = {
            approvalOption,
            approversCount
        };

        const workflowObject = Object.assign(workflowParams, { workflowId, workflowStatus, workflowName, resourceType, approvers, approvalOptions });
        console.log(`:: handleSaveWorkflow -> workflowObject`, workflowObject);
        try {
            const saved = await updateWorkflow(workflowId ? 'PATCH' : 'POST', workflowObject);
            alert(`Workflow saved!`);
            getWorkflowsList();
            handleLoadWorkflowParams();
        } catch (err) {
            alert(`Error saving workflow`);
            console.error(err);
        }
    }

    function getVolumeTypes(volumeTypeSelections) {
        const volumeTypes = [];
        volumeTypeSelections.each((index, volumeTypeEl) => {
            const volumeTypeCode = volumeTypeEl.value;
            const sizeSlider = document.querySelector(`#size_${volumeTypeCode}`);
            const size = sizeSlider && sizeSlider.noUiSlider.get().map(x => parseInt(x));
            const iopsSlider = document.querySelector(`#iops_${volumeTypeCode}`);
            const iops = iopsSlider && iopsSlider.noUiSlider.get().map(x => parseInt(x));
            console.log(`SIZE + IOPS => `, volumeTypeCode, size, iops);
            volumeTypes.push({volumeTypeCode, size, iops});
        });
        return volumeTypes;
    }

    function handleApproverOptionsChange(e) {
        $('#paramsApproversOptionsList input[name=paramsApproversOptions]:checked').val();
    }

    function changeWorkflowState(workflowId, enabled) {
        return updateWorkflow('PATCH', {
            workflowId,
            workflowStatus: enabled ? 'ACTIVE' : 'INACTIVE'
        });
    }

    async function updateWorkflow(method = 'POST', requestBodyJson) {
        return requestData({
            method: method,
            url: `/clouds/AWS_ACCOUNT_ID/regions/REGION/workflows`,
            data: JSON.stringify(requestBodyJson)
        });
    }

    function validateWorkflow() {
        const workflowName = $('#inputWorkflowName').val();
        const resourceType = $('#inputResourceType').val();
        if (!workflowName || !resourceType) {
            alert(`Please enter a workflow name.`);
            return false;
        }
        let workflowIsValid, 
            message = `Please authorize - `;
        const { 
            vpcCount, subnetCount, securityGroupCount, imageCount, 
            instanceTypeCount, keyPairCount, 
            volumeTypeCount,
            bundleCount, approverCount
        } = getBadgeCounts();

        if (resourceType === 'EC2') {
            const allowVolumes = $('#allowVolumes').is(':checked');
            workflowIsValid = vpcCount > 0 && subnetCount > 0 && securityGroupCount > 0 && imageCount > 0 
            && instanceTypeCount > 0
            && (!allowVolumes || (allowVolumes && volumeTypeCount > 0)); // && keyPairCount > 0;
            message = `${message}
                ${vpcCount === 0 ? '<br/> 1 VPC' : ''} 
                ${subnetCount === 0 ? '<br/> 1 subnet' : ''} 
                ${securityGroupCount === 0 ? '<br/> 1 security group' : ''} 
                ${instanceTypeCount === 0 ? '<br/> 1 instance type' : ''}
                ${imageCount === 0 ? '<br/> 1 image' : ''}
                ${allowVolumes && volumeTypeCount === 0 ? '<br/> 1 volume type' : ''}
                `;
                //  ${keyPairCount === 0 ? '1 key pair' : ''}
        } else if (resourceType === 'WorkSpaces') {
            workflowIsValid = bundleCount > 0;
            message = `${message}
                ${bundleCount === 0 ? '<br/> 1 bundle': ''}`;
        }        
    
        if (approverCount < 1) {
            workflowIsValid = false;
            message = `${message} <br/> 1 approver`;
        }

        return { workflowIsValid, message };
    }

    function handleVpcChange(e) {
        const vpc = $(e.target).val();
        const vpcIsSelected = $(e.target).is(':checked');
        const subnetsForVpc = $(`#ec2ParamsSubnetsTable input[type="checkbox"][data-vpc="${vpc}"]`);
        const securityGroupsForVpc = $(`#ec2ParamsSecurityGroupsTable input[type="checkbox"][data-vpc="${vpc}"]`);
        if (vpcIsSelected) {
            subnetsForVpc.removeAttr('disabled').parent().removeClass('disabled');
            securityGroupsForVpc.removeAttr('disabled').removeClass('disabled');
        } else {
            uncheckItems(subnetsForVpc, true);
            uncheckItems(securityGroupsForVpc, true);
        }
    }

    function uncheckItems(jqcheckItemsCollection, disableVpcItems = false) {
        jqcheckItemsCollection.prop('checked', false); 
        jqcheckItemsCollection.filter('.item-check-vpc').trigger('change');
        if (disableVpcItems) {
            jqcheckItemsCollection.filter('.item-check-subnet, .item-check-securitygroup').attr('disabled', true).addClass('disabled');
        }
        updateCounters();
    }

    function updateCounters(e) {
        const { vpcCount, subnetCount, securityGroupCount, imageCount, volumeTypeCount,
            bundleCount, approverCount, instanceTypeCount, keyPairCount
        } = getBadgeCounts();

        const subnetBadge        = `${subnetCount} subnet${subnetCount !== 1 ? 's' : ''} across ${vpcCount} VPC${vpcCount !== 1 ? 's' : ''} selected`;
        const securityGroupBadge = `${securityGroupCount} SG${securityGroupCount !== 1 ? 's' : ''} across ${vpcCount} VPC${vpcCount !== 1 ? 's' : ''} selected`;
        const imageBadge         = `${imageCount} selected`;                                                                                                      // image${imageCount !== 1 ? 's' : ''}
        const instanceTypeBadge  = `${instanceTypeCount} selected`;
        const keyPairBadge       = `${keyPairCount} selected`;
        const bundleBadge        = `${bundleCount} bundle${bundleCount !== 1 ? 's' : ''} selected`;
        const approverBadge      = `${approverCount} selected`;
        const storageBadge       = `${volumeTypeCount} volume types selected`;
        // console.log({ vpcCount, subnetCount, securityGroupCount, imageBadge, bundleCount, approverCount }, subnetBadge, securityGroupBadge, bundleBadge, approverBadge, keyPairBadge);
        setBadgeText('#params-counter-subnets', subnetBadge);
        setBadgeText('#params-counter-securitygroups', securityGroupBadge);
        setBadgeText('#params-counter-bundles', bundleBadge);
        setBadgeText('#params-counter-images', imageBadge);
        setBadgeText('#params-counter-instancetypes', instanceTypeBadge);
        setBadgeText('#params-counter-keypairs', keyPairBadge);
        setBadgeText('#params-counter-approvers', approverBadge);
        setBadgeText('#params-counter-storage', storageBadge);
        $('.item-check-clear-selected').off('**').on('click', handleClearParamsItemSelection);//.tooltip();
    }

    function setBadgeText(badgeIdentifier, badgeText) {
        $(badgeIdentifier)
            .text(badgeText)
            .append(`&nbsp;&nbsp;&nbsp;<i class="item-check-clear-selected text-small text-warning material-icons" data-toggle="tooltip" data-placement="bottom" title="Clear selection">clear_all</i>`);
    }

    function getSelectedParamItems() {
        return {
            vpcs          : $('#ec2ParamsVpcsTable input[type="checkbox"]:checked'),
            subnets       : $('#ec2ParamsSubnetsTable input[type="checkbox"]:checked'),
            securityGroups: $('#ec2ParamsSecurityGroupsTable input[type="checkbox"]:checked'),
            images        : $('#ec2ParamsImagesTable input[type="checkbox"]:checked'),
            instanceTypes : $('#ec2ParamsInstanceTypesTable input[type="checkbox"]:checked'),
            keyPairs      : $('#ec2ParamsKeyPairsTable input[type="checkbox"]:checked'),
            volumeTypes   : $('#ec2ParamsStorageTable input[class*="item-check-volumetype"][type="checkbox"]:checked'),
            bundles       : $('#workspacesParamsBundlesTable input[type="checkbox"]:checked'),
            approvers     : $('#paramsApproversTable input[type="checkbox"]:checked'),
        };
    }

    function getBadgeCounts() {
        const selectedItems = getSelectedParamItems();
        return {
            vpcCount          : selectedItems.vpcs.length,
            subnetCount       : selectedItems.subnets.length,
            securityGroupCount: selectedItems.securityGroups.length,
            imageCount        : selectedItems.images.length,
            instanceTypeCount : selectedItems.instanceTypes.length,
            keyPairCount      : selectedItems.keyPairs.length,
            volumeTypeCount   : selectedItems.volumeTypes.length,
            bundleCount       : selectedItems.bundles.length,
            approverCount     : selectedItems.approvers.length,
        };
    }

    function handleClearParamsItemSelection(e) { 
        e.preventDefault();
        e.stopImmediatePropagation();
        const containerItemCheckboxes = $(e.target).parents('.workflow-params').find('input[type="checkbox"]');
        // console.log('handleClearParamsItemSelection', containerItemCheckboxes);
        uncheckItems(containerItemCheckboxes);
    }

    const defaultItemTemplate = ({ marker, value, title, desc, attrName = null, attrVal = null, disabled = false, checked = false, namespaceId = false }) => {
        const id = namespaceId ? `${marker}_${value}` : value;
        return `
        <li class="py-2">
            <div class="custom-control custom-checkbox">
                <input type="checkbox" class="custom-control-input ${marker ? `item-check-${marker}` : ''}"
                    id="${id}"
                    value="${value}" 
                    ${attrName && attrVal ? `data-${attrName}="${attrVal}"` : ''} 
                    ${disabled ? 'disabled' : ''}
                    ${checked ? 'checked' : ''}
                    >
                <label style="font-size:14px!important" class="custom-control-label" for="${id}">
                    <span>${title && title}  ${desc && desc}</span>
                </label>
            </div>
        </li>`
    };

    const vpcDisplay =  ({ VpcId, Tags, CidrBlock }) => {
        const vpcNameTag = Tags.find(t => t.Key === 'Name');
        const vpcName = (vpcNameTag && vpcNameTag.Value) || '';
        return { title: `${VpcId} | ${vpcName}`, desc: CidrBlock };
    }

    const ec2ParamsVpcsItemTemplate = ({ VpcId, Tags, CidrBlock }) => {
        const { title, desc } = vpcDisplay({ VpcId, Tags, CidrBlock });
        return defaultItemTemplate({ marker: 'vpc', value: VpcId, title, desc });
    }

    const subnetDisplay = ({ SubnetId, VpcId, AvailabilityZone, Tags, CidrBlock }) => {
        const subnetNameTag = Tags.find(t => t.Key === 'Name');
        const subnetName = `${SubnetId} ${(subnetNameTag && ' - ' + subnetNameTag.Value) || ''}`;
        const title = subnetName, desc = `${AvailabilityZone} | ${CidrBlock}  <br/><small>(VPC: ${VpcId})</small>`;
        return { title, desc };
    }

    const ec2ParamsSubnetsItemTemplate = ({ SubnetId, VpcId, AvailabilityZone, Tags, CidrBlock }) => {
        const { title, desc } = subnetDisplay({ SubnetId, VpcId, AvailabilityZone, Tags, CidrBlock });
        return defaultItemTemplate({
            marker: 'subnet', value: SubnetId, 
            title: title, desc: desc,
            attrName: 'vpc', attrVal: VpcId, disabled: true
        });
    }

    const securityGroupDisplay = ({ GroupId, GroupName, Description, VpcId, IpPermissions }) => {
        return { title: `${GroupId} - ${GroupName}`, desc: ` | ${Description} <br/><small>(VPC: ${VpcId})</small>` };
    }

    const ec2ParamsSecurityGroupsItemTemplate = ({ GroupId, GroupName, Description, VpcId, IpPermissions }) => {
        const { title, desc } = securityGroupDisplay({ GroupId, GroupName, Description, VpcId, IpPermissions });
        return defaultItemTemplate({
            marker: 'securitygroup', value: GroupId,
            title: title, desc: desc, 
            attrName: 'vpc', attrVal: VpcId, disabled: true
        });
    }

    const workflowSecurityGroupsItemTemplate = ({ GroupId, GroupName, Description, VpcId, IpPermissions }) => {
        const { title, desc } = securityGroupDisplay({ GroupId, GroupName, Description, VpcId, IpPermissions });
        return defaultItemTemplate({
            marker: 'securitygroup2', value: `${GroupId}_${GroupName}`,
            title: title, desc: desc, 
            attrName: 'vpc', attrVal: VpcId, disabled: true
        });
    }

    const ec2ParamsKeyPairsItemTemplate = ({ KeyName, KeyFingerprint }) => {
        const { title, desc } = keyPairDisplay({ KeyName, KeyFingerprint });
        return defaultItemTemplate({
            marker: 'keyPair', value: KeyName, 
            title: title, desc: desc,
        });
    }

    const keyPairDisplay = ({ KeyName, KeyFingerprint }) => {
        return { title: `${KeyName}`, desc: ` | ${KeyFingerprint}` };
    }

    const ec2ParamsInstanceTypesItemTemplate = ({ instanceType, instanceFamily, memory, vcpu, clockSpeed }) => {
        // (instanceTypeJsonString) => {
        // const { instanceType, instanceFamily, memory, vcpu, clockSpeed } = JSON.parse(instanceTypeJsonString);
        return defaultItemTemplate({
            marker: 'instancetype', value: instanceType,
            title: `${instanceType}`, desc: `[  ${instanceFamily}, ${memory}, ${vcpu} vcpu ${clockSpeed || ''}  ]`,
        });
    }

    const workspaceParamsBundleItemTemplate = ({ BundleId, Name, Description, price }) => 
        defaultItemTemplate({ marker: 'bundle', value: BundleId, title: Name, desc: `<br/> <small>${Description}</small>` });

    const approversItemTemplate = ({ userId, username, isAdmin, isAutoApprove}) => 
        defaultItemTemplate({ marker: 'user', value: userId, title: `${username} ${isAdmin ? ' (Admin)': ''} `, desc: '',
        attrName: 'auto-approve', attrVal: isAutoApprove
    });

    const imageDisplay = ({ AmiResolved, ImageId, Name, Description, Architecture }) => {
        return {
            title: `${ImageId} - ${AmiResolved ? (Name || '' ) : '<span class="text-warning">AMI not resolved!</span>' }`,
            desc: `<br/> <small>${AmiResolved ? (Description || '') : '<span class="text-danger">May not be a valid AMI identifier for the selected region</span>.'} </small>`,
        };
    }

    const ec2ParamsImageListItemTemplate = ({ AmiResolved, ImageId, Name, Description, Architecture }) => {
        const { title, desc } =  imageDisplay({ AmiResolved, ImageId, Name, Description, Architecture });
        return defaultItemTemplate({
            marker: 'image', value: ImageId,
            title: title, desc: desc,
            disabled: (AmiResolved === false), checked: (AmiResolved === true)
        });
    }

    async function handleResolveEc2ImageList(e) {
        e.preventDefault();
        const inputEc2ParamsImageList = $('#inputEc2ParamsImageList').val();
        if (!inputEc2ParamsImageList) {
            $('#inputEc2ParamsImageList').addClass('invalid');
            return false;
        }
        await requestData({
            method: 'POST',
            url: `/clouds/AWS_ACCOUNT_ID/regions/REGION/workflows/params/EC2/validate`,
            data: JSON.stringify({
                amiIdCsvList: inputEc2ParamsImageList
            })
        }).then(images => {
            console.log('handleResolveEc2ImageList', images);
            renderCollection(images, '', 1, ec2ParamsImageListItemTemplate, 'ec2ParamsImagesTable');
            $('.item-check-image').off('change').on('change', updateCounters);
        }).catch(err => {
            console.error('handleResolveEc2ImageList', err);
            $('#ec2ParamsImagesTable').html(`<span class="text-warning">Sorry, we're unable to resolve the AMI list. Please retry or contact your administrator for support. </span>`);
        });
    }
    
    const bundleDisplay = ({ BundleResolved, BundleId, Name, Description, Owner }) => {
        return {
            title: `${BundleId} - ${BundleResolved ? (`${Name} (Owner: ${Owner})` || '' ) : '<span class="text-warning">Bundle ID not resolved!</span>' }`,
            desc: `<br/> <small>${BundleResolved ? (Description || '') : '<span class="text-danger">May not be a valid Bundle identifier for the selected region</span>.'} </small>`,
        };
    }

    const workspaceParamsBundleItemTemplate2 = ({ BundleResolved, BundleId, Name, Description, Owner }) => {
        const { title, desc } = bundleDisplay({ BundleResolved, BundleId, Name, Description, Owner });
        return defaultItemTemplate({
            marker: 'bundle', value: BundleId,
            title: title, desc: desc,
            disabled: (BundleResolved === false), checked: (BundleResolved === true)
        });
    }

    async function handleResolveWorkspacesBundleList(e) {
        e.preventDefault();
        const inputworkspacesBundleList = $('#inputworkspacesBundleList').val();
        if (!inputworkspacesBundleList) {
            $('#inputworkspacesBundleList').addClass('invalid');
            return false;
        }
        await requestData({
            method: 'POST',
            url: `/clouds/AWS_ACCOUNT_ID/regions/REGION/workflows/params/WorkSpaces/validate`,
            data: JSON.stringify({
                bundleIdCsvList: inputworkspacesBundleList
            })
        }).then(bundles => {
            console.log('handleResolveWorkspacesBundleList', bundles);
            renderCollection(bundles, 'Name', 1, workspaceParamsBundleItemTemplate2, 'workspacesParamsBundlesTable');
            $('.item-check-bundle').off('change').on('change', updateCounters);
        }).catch(err => {
            console.error('handleResolveWorkspacesBundleList', err);
            $('#workspacesParamsBundlesTable').html(`<span class="text-warning">Sorry, we're unable to resolve the AMI list. Please retry or contact your administrator for support. </span>`);
        });
    }

    function handleSelectWorkflow(e) {
        const workflowId = $('#selectSavedWorkflows').val();
        if (!workflowId) return;
        getWorkflowInfo(workflowId, true)
            .then(workflow => {
                console.log(workflow);
                const { workflowId, workflowName, resourceType, 
                    vpcDetails, subnetDetails, securityGroupDetails, 
                    imageDetails, instanceTypes, keyPairDetails, 
                    leaseOptions, 
                    approvers, approvalOptions,
                    volumeTypes, storageOptions,
                    awsBundleDetails, workspaceOptions
                } = workflow;

                $('#selectWorkflowResourceType').val(resourceType);
                $('#selectWorkflowPricing').val('');
                $('#workflowJustification').val('');
                $(`#requestWorkflowForm > div[class*="workflow-request"]`).hide();
                $(`#requestWorkflowForm div.workflow-request-${resourceType.toLowerCase()}`).removeAttr('hidden').show();
                $(`#workflowButtons`).removeAttr('hidden').show();

                $('#selectApprovers').val(JSON.stringify(approvers));
                $('#selectApprovalOptions').val(JSON.stringify(approvalOptions));

                if (resourceType === 'EC2') {
                    renderSelectOptions('AMI', imageDetails, 'ImageId' , imageOptionsTemplate, 'selectWorkflowImage');
                    renderSelectOptions('Instance Type', instanceTypes, '' , instanceTypeOptionsTemplate, 'selectWorkflowInstanceType');
                    renderSelectOptions('Key Pair', keyPairDetails, 'KeyName' , keyPairOptionsTemplate, 'selectWorkflowKeyPair');
                    renderSelectOptions('VPC', vpcDetails, 'CidrBlock' , vpcOptionsTemplate, 'selectWorkflowVPC');
                    renderSelectOptions('Subnet', subnetDetails, 'CidrBlock' , subnetOptionsTemplate, 'selectWorkflowSubnet');
                    renderSelectOptions('Security Group', securityGroupDetails, 'VpcId' , securityGroupOptionsTemplate, 'selectWorkflowSecurityGroup');
                    // renderCollection(securityGroupDetails, 'VpcId', 1, workflowSecurityGroupsItemTemplate, 'workflowSecurityGroupsTable');
                    $('#selectWorkflowVPC').off().on('change', handleVpcSelectionChange);
                    
                    if (storageOptions.maxVolumeCount) {
                        $('#storageOptionsMessage').html(`Your administrator has configured a maximum of <strong>${storageOptions.maxVolumeCount}</strong> additional volumes.`);
                        $('#selectStorageOptions').val(JSON.stringify(storageOptions));
                        $('#selectVolumeTypes').val(JSON.stringify(volumeTypes));
                        $('#addedVolumesCount').val(0);
                        $('#addVolume').prop('disabled', false).off('click').on('click', handleAddVolume);
                    } else {
                        $('#storageOptionsMessage').text(`Your administrator has not configured any additional volumes.`);
                        $('#selectStorageOptions').val('');
                        $('#selectVolumeTypes').val('');
                        $('#addedVolumesCount').val(0);
                        $('#addVolume').prop('disabled', true);
                    }

                    $('#selectLeaseOptions').val(JSON.stringify(leaseOptions));

                } else if (resourceType === 'WorkSpaces') {
                    renderSelectOptions('Bundle', awsBundleDetails, 'Name' , bundleOptionsTemplate, 'selectWorkflowBundle');
                    $('#workspacesOptionsMessage').text(workspaceOptions.runningMode === 'runningmode-alwayson' 
                        ? ` run Always-On` 
                        : ` automatically shut-down after ${workspaceOptions.autoStopHours} hour${workspaceOptions.autoStopHours > 1 ? 's' : ''}`);
                    $('#selectWorkspaceOptions').val(JSON.stringify(workspaceOptions));
                }
            }).catch(err => {
                console.error(err);
                alert(`Uh-oh! we're having some trouble fetching details for that workflow`);
            });
    }

    function resetWorkflowRequestForm(e) {
        // $('#requestWorkflowForm input').val('');
        // console.log($('#selectSavedWorkflows').val());
        if ((e && $('#selectSavedWorkflows').val() && confirm('Discard selections?') || !e)) {
            $('#selectSavedWorkflows option').prop('selected', false);
            $('#selectSavedWorkflows option[value="0"').prop('selected', true);
            $('#selectSavedWorkflows').formSelect();

            $('#requestWorkflowForm div[class*="workflow-request"] select').html('').formSelect();
            $('#requestWorkflowForm div[class*="workflow-request"]').hide();
            $('#workflowJustification').val('');
            $('#workflowButtons').hide();
            $('#additionalVolumesTable').html('');
            $('storageOptionsMessage').text('');
        }
    }

    function handleVpcSelectionChange(e) {
        const vpc = $(e.target).val();
        resetVpcSelectOptions('selectWorkflowSubnet');
        resetVpcSelectOptions('selectWorkflowSecurityGroup');
        $(`#workflowSecurityGroupsTable input[type="checkbox"]`).prop('checked', false).attr('disabled', true);
        $(`#workflowSecurityGroupsTable input[type="checkbox"][data-vpc="${vpc}"]`).attr('disabled', false).removeClass('disabled');

        function resetVpcSelectOptions(vpcDependentSelect) {
            $(`#${vpcDependentSelect} option`).attr('selected', false).attr('disabled', true);
            $(`#${vpcDependentSelect} option[data-vpc="${vpc}"]`).attr('disabled', false);
            if ($(`#${vpcDependentSelect}`).attr('multiple')) {
                $(`#${vpcDependentSelect}`).val();
                // $(`#${vpcDependentSelect} option`).attr('selected', false);
            } else {
                $(`#${vpcDependentSelect} option:first-child`).attr('selected', true);
            }
            $(`#${vpcDependentSelect}`).formSelect();
        }
    }

    function handleAddVolume(e) {
        e.preventDefault();
        const { maxVolumeCount } = JSON.parse($('#selectStorageOptions').val() || "{}");
        const volumeTypes = JSON.parse($('#selectVolumeTypes').val() || "{}");
        const volumeCounter = parseInt($('#addedVolumesCount').val() || "0");

        if (volumeCounter >= maxVolumeCount) {
            alert(`Looks like you've already added the maximum authorized (${maxVolumeCount}) additional EBS volumes! `);
            return false;
        } else {
            $('#addedVolumesCount').val(volumeCounter + 1);
        }

        const rowTemplate = `

            <hr/>

        <li class="collection-item row m-2 item-volume" style="height: 100px">
            <div class="input-field col-md-2">
                <label class="active" for="requestVolumeDevice_${volumeCounter}">Device Name</label>
                <input type="text" id="requestVolumeDevice_${volumeCounter}" 
                    name="requestVolumeDevice_${volumeCounter}" 
                    placeholder="/dev/sd[a-f]" 
                    value="${getDeviceName(volumeCounter)}"
                    />
            </div>
            <div class="col-md-4">
                <label for="selectWorkflowVolumeType_${volumeCounter}">Type</label>
                <select id="selectWorkflowVolumeType_${volumeCounter}" 
                    name="requestVolumeType_${volumeCounter}">
                </select>
            </div>
            <div class="col-md-5">
                <p class="range-field" id="size_container_${volumeCounter}" class="text-small" hidden>
                    <label for="requestSize_${volumeCounter}">Size:</label>
                    <i class="my-0 input-field inline">
                        <input id="requestSize_${volumeCounter}" type="range" value="0" />
                    </i>
                    <span id="requestSize_val_${volumeCounter}"></span>
                </p>
                <p class="range-field" id="iops_container_${volumeCounter}" class="text-small" hidden>
                    <label for="requestIOPS_${volumeCounter}">IOPS:</label>
                    <i class="my-0 input-field inline">
                        <input id="requestIOPS_${volumeCounter}" type="range" value="0" />
                    </i>
                    <span id="requestIOPS_val_${volumeCounter}"></span>
                </p>
            </div>
            <div class="input-field col-md-1">
                <i class="material-icons" data-toggle="tooltip" data-placement="bottom" title="Delete Volume">delete</i>
        </div>
        </li>
        `;
        $(`#additionalVolumesTable`).append(rowTemplate);
        $(`#requestSize_${volumeCounter}`).range();
        $(`#requestIOPS_${volumeCounter}`).range();
        $(`#additionalVolumesTable [data-toggle="tooltip"]`).tooltip();
        renderSelectOptions('Volume Type', volumeTypes, '', volumeOptionsTemplate, `selectWorkflowVolumeType_${volumeCounter}`);
        $(`#selectWorkflowVolumeType_${volumeCounter}`)
            .off().on('change', { volumeTypes, volumeCounter }, handleVolumeTypeSelectionChange);
        $(`#size_container_${volumeCounter}`)
            .off().on('change', `input`, {volumeCounter}, (e) => {
                $(`#requestSize_val_${e.data.volumeCounter}`).text(`${$(e.target).val()}`);
            } );
        $(`#iops_container_${volumeCounter}`)
            .off().on('change', `input`, {volumeCounter}, (e) => {
                $(`#requestIOPS_val_${e.data.volumeCounter}`).text(`${$(e.target).val()}`);
            } );
    }

    function getDeviceName(volumeCounter) {
        return `/dev/sd${'fghijklmnop'.charAt(volumeCounter)}`;
    }
    
    function handleVolumeTypeSelectionChange(e) {
        const { volumeTypes, volumeCounter } = e.data;
        const selectedVolumeType = $(e.target).val();
        const volume = volumeTypes.find(({volumeTypeCode}) => volumeTypeCode === selectedVolumeType);
        
        const { volumeTypeCode, size, iops } = volume;
        // console.log(`: handleVolumeTypeSelectionChange -> size, iops, volumeCounter`, size, iops, volumeCounter);
        $(`#requestSize_${volumeCounter}`)
            .prop('disabled', false)
            .attr('min', size[0])
            .attr('max', size[1])
            .val(size[0]).trigger('change');
            // .removeAttr('hidden').show();
        $(`#size_container_${volumeCounter}`).removeAttr('hidden').show();
        if (iops) {
            $(`#requestIOPS_${volumeCounter}`)
            .prop('disabled', false)
            .attr('min', iops[0])
            .attr('max', iops[1])
            .val(iops[0]).trigger('change');
            $(`#iops_container_${volumeCounter}`).removeAttr('hidden').show();
        } else {
            $(`#requestIOPS_${volumeCounter}`).prop('disabled', true);;
            $(`#iops_container_${volumeCounter}`).prop('hidden', true).hide();
        }
    }

    const defaultOptionTemplate = ({valueProp, textProp, attrName, attrValue, disabled }) => {
        return $(`<option 
            ${attrName && attrValue ? `data-${attrName} = "${attrValue}"` : ''} 
            value="${valueProp}" 
            ${disabled ? ' disabled' : ''}>${textProp}
        </option>`);
    };

    const imageOptionsTemplate = ({ AmiResolved, ImageId, Name, Description, Architecture }) => {
        const { title, desc } =  imageDisplay({ AmiResolved, ImageId, Name, Description, Architecture });
        return defaultOptionTemplate({ valueProp: ImageId, textProp: `${Name || Description}`, disabled: false });
    };

    const instanceTypeOptionsTemplate = (image) => {
        return defaultOptionTemplate({ valueProp: image, textProp: image, disabled: false });
    };

    const keyPairOptionsTemplate = ({ KeyName }) => {
        return defaultOptionTemplate({ valueProp: KeyName, textProp: KeyName, disabled: false });
    };

    const vpcOptionsTemplate = ({ VpcId, Tags, CidrBlock }) => {
        const { title, desc } = vpcDisplay({ VpcId, Tags, CidrBlock });
        return defaultOptionTemplate({ valueProp: VpcId, textProp: `${title} | ${desc}`, disabled: false });
    };

    const subnetOptionsTemplate = ({ SubnetId, VpcId, AvailabilityZone, Tags, CidrBlock }) => {
        const { title, desc } = subnetDisplay({ SubnetId, VpcId, AvailabilityZone, Tags, CidrBlock });
        return defaultOptionTemplate({ valueProp: SubnetId, textProp: `${title} | ${desc}`, attrName: 'vpc', attrValue: VpcId, disabled: true});
    };

    const securityGroupOptionsTemplate = ({ GroupId, GroupName, Description, VpcId, IpPermissions }) => {
        const { title, desc } = securityGroupDisplay({ GroupId, GroupName, Description, VpcId, IpPermissions });
        return defaultOptionTemplate({ valueProp: GroupId, textProp: `${title}`, attrName: 'vpc', attrValue: VpcId, disabled: true });
    };

    const bundleOptionsTemplate = ({ BundleId, Name, Description }) =>
        defaultOptionTemplate({ valueProp: BundleId, textProp: `${Name}` });

    const volumeOptionsTemplate = (volume) => {
        const { volumeTypeCode, size, iops } = volume;
        const { volumeTypeName } = volumeTypeConfigs.find(vol => vol.volumeTypeCode === volumeTypeCode);
        const desc = `${volumeTypeName}`; // : ${size[0]} - ${size[1]} ${iops ? `@ ${iops[0]} - ${iops[1]}` : ''} `;
        const template = defaultOptionTemplate({ valueProp: volumeTypeCode, textProp: desc }); //, attrName: 'volume', attrValue: JSON.stringify(volume) });
        // template.data('volume', volume);
        // console.log('volume set -> ', template.data('volume'));
        return template;
    }

    function renderSelectOptions(marker, itemArray, sortField, optionTemplate, targetSelect) {
        // console.log('renderSelectOptions', marker, itemArray, optionTemplate, targetSelect);
        if (sortField) {
            itemArray = itemArray.sort((x,y) => x[sortField] > y[sortField] ? 1 : -1);
        } else {
            itemArray = itemArray.sort((x,y) => x > y ? 1 : -1);
        }
        const options = itemArray.map(item => optionTemplate(item));
        const isMultiple = $(`#${targetSelect}`).attr('multiple');
        $(`#${targetSelect}`).html('')
            .append(`<option value="0" disabled selected>${'   .   '.repeat(15)}</option>`)
            .append(options)
            .formSelect();
        // $(`#${targetSelect}`).html('').append(`<option value="!" disabled selected>Please select ${marker}</option>`).append(options).formSelect();
        // $(`#${targetSelect}`).html('').append(`<option value="!" disabled ${isMultiple ? '' : ' selected'}>Please select ${marker}</option>`).append(options).formSelect();
        // if (isMultiple) {
        //     console.log('MULTIPLE', $(`#${targetSelect} option:first-child`));
        // }
    }
    
    async function handleSubmitWorkflowRequest(e) {
        e.preventDefault();
        const isPricingRequest = e.data && e.data.pricing;
        const { isValid, message, workflowRequest } = validateWorkflowRequest();
        if (!isValid) {
            alert(message);
            return false;
        }
        try {
            const { userTags } = await getUserTags(); //.then(({ userTags }) => {
            console.log(`attaching user tags to workflow request...`, userTags);
            workflowRequest['userTags'] = userTags;
            console.log(workflowRequest);

            const response = await saveWorkflowRequest({ workflowRequest, isPricingRequest }); 
            if (isPricingRequest) { // handle pricing request
                console.log(isPricingRequest, response);
                let { serviceCode, price, priceDisplay } = response;
                if (price) {
                    price = parseFloat(price).toFixed(2);
                    priceDisplay = `USD ${price}/Month`;
                    $('#selectWorkflowPricing').val(priceDisplay);
                    // alert(price);
                } else {
                    let pricingUrl = '';
                    if (serviceCode === 'AmazonEC2') {
                        pricingUrl = `https://aws.amazon.com/ec2/pricing/on-demand/`;
                    } else if (serviceCode === 'AmazonWorkSpaces') {
                        pricingUrl = `https://aws.amazon.com/workspaces/pricing/`;
                    }
                    alert(`<span>Unable to fetch pricing for the request! This may possibly be an unsupported combination. <br/> Please <a href="${pricingUrl}" target="_blank" class="text-info">check</a> prior to submitting to avoid rejection or launch failure.</span>`);
                }
                return;
            } else {
                const { workflowRequestId, workflowId, workflowName, resourceType, workflowRequestStatus } = response;
                alert(`<span>Okay, your request for ${resourceType} workflow ${workflowName} has been submitted. <br/> You can track with the request id <b class="text-info">${workflowRequestId}</b></span>`);
                getWorkflowRequests();
                resetWorkflowRequestForm();
            }
        } catch (err) {
            console.error(err);
            alert(`Oops! There was an error processing your request. Please retry or contact your administrator for support.`);
        }
    }

    async function saveWorkflowRequest({workflowRequest, isPricingRequest = false}) {
        return requestData({
            method: 'POST',
            url: `/clouds/AWS_ACCOUNT_ID/regions/REGION/workflows/requests${isPricingRequest ? '/pricing' : ''}`,
            data: JSON.stringify(workflowRequest)
        });
    }

    function validateWorkflowRequest() {
        let isValid = true, message = $(`<span>Something's not right! Please check these values -</span>`);
        const resourceType  = $('#selectWorkflowResourceType').val();
        const workflowId    = $('#selectSavedWorkflows').val();
        const workflowName  = $("#selectSavedWorkflows option:selected").text();
        const requestReason = $('#workflowJustification').val();
        if (!requestReason) {
            isValid = false;
            message.append(`<br/> - Justification`);
        }
        const workflowRequest = {
            requestReason,
            resourceType,
            workflowId,
            workflowName,
            requester: USER_NAME
        };
        const selections = $(`#requestWorkflowForm div.workflow-request-${resourceType.toLowerCase()} select`);
        selections.each((i, select) => {
            const selectValue = $(select).val();
            const isRequired = $(select).attr('required');
            if (isRequired && (!selectValue || (Array.isArray(selectValue) && selectValue.length === 0)) ){
                isValid = false;
                message.append(`<br/> - ${select.name}`);
            } else {
                workflowRequest[select.name] = selectValue;
            }
        });
        
        workflowRequest['approvers'] = JSON.parse($('#selectApprovers').val() || '{}');
        workflowRequest['approvalOptions'] = JSON.parse($('#selectApprovalOptions').val() || '{}');

        if (resourceType === 'WorkSpaces') {
            workflowRequest['workspaceOptions'] = JSON.parse($('#selectWorkspaceOptions').val() || '{}');
        }
        if (resourceType === 'EC2') {
            workflowRequest['leaseOptions']    = JSON.parse($('#selectLeaseOptions').val() || '{}');
            workflowRequest['storageOptions']  = JSON.parse($('#selectStorageOptions').val() || '{}');

            const addedVolumesCount = parseInt($('#addedVolumesCount').val() || '0');
            const addedVolumes = [];
            for (let volumeCounter = 0; volumeCounter < addedVolumesCount; volumeCounter++) {
                let addedVolume = {
                    deviceName: $(`#requestVolumeDevice_${volumeCounter}`).val(),
                    volumeType: $(`#selectWorkflowVolumeType_${volumeCounter}`).val(),
                    size: parseInt($(`#requestSize_${volumeCounter}`).val() || '0'),
                    iops: parseInt($(`#requestIOPS_${volumeCounter}`).val() || '0'),
                }
                console.log(`volumes added => `, addedVolume);
                if (!addedVolume.volumeType || !addedVolume.deviceName) {
                    isValid = false;
                    message.append(`<br/> - Volume configuration #${volumeCounter}`);
                } else {
                    addedVolumes.push(addedVolume);
                }
            }
            workflowRequest['addedVolumes'] = addedVolumes;
        }
        return { isValid, message, workflowRequest };
    }

    const workflowRequestItemTemplate = ({ workflowName, workflowId, workflowRequestId, createdAt, workflowRequestStatus, resourceType }) => {
        let workflowStatusDecoration, cancelable = false, repeatable = true, archivable = true;
        switch(workflowRequestStatus) {
            case 'SUBMITTED':
                cancelable = true;
                workflowStatusDecoration = 'text-primary';
                break;
            case 'FULFILLED':
                workflowStatusDecoration = 'text-success';
                break;
            case 'FAILED':
                workflowStatusDecoration = 'text-danger';
                break;
            default:
                workflowStatusDecoration = 'text-dark';
                break;
        }

        return `
            <li class="collection-item">
                <div>
                <!-- </div>
                <div> -->
                <strong class="text-dark">${workflowRequestId}</strong>
                <span class="right">

                    ${cancelable ? 
                        `<i class="tiny material-icons workflow-request-action text-dark" style="cursor: pointer;" data-action="cancelWorkflowRequest" 
                        data-workflow-id="${workflowId}" data-workflow-name="${workflowName}" data-workflow-request-id="${workflowRequestId}"
                        data-toggle="tooltip" data-placement="bottom" title="//TODO: Cancel Request">cancel</i>`
                    : ''}
<!--
                    ${archivable ? 
                        `<i class="tiny material-icons workflow-request-action text-dark" style="cursor: pointer;" data-action="archiveWorkflowRequest" 
                        data-workflow-id="${workflowId}" data-workflow-name="${workflowName}" data-workflow-request-id="${workflowRequestId}"
                        data-toggle="tooltip" data-placement="bottom" title="//TODO: Archive Request">archive</i>`
                    : ''}
-->
                    ${repeatable ? 
                        `<i class="tiny material-icons workflow-request-action text-dark" style="cursor: pointer;" data-action="retryWorkflowRequest" 
                        data-workflow-id="${workflowId}" data-workflow-name="${workflowName}" data-workflow-request-id="${workflowRequestId}"
                        data-toggle="tooltip" data-placement="bottom" title="//TODO: Repeat Request">redo</i>`
                    : ''}

                </span>
                </div>
                <ul style="list-style-type:inside!important;">
                    <li class="text-nowrap text-small"> <em>Workflow: </em> ${workflowName}</li>
                    <li class="text-nowrap text-small"> <em>Resource Type: </em> ${resourceType}</li>
                    <li class="text-nowrap text-small"> <em>Status: </em> <span class="${workflowStatusDecoration}">${workflowRequestStatus}</span></li>
                    <li class="text-nowrap text-small"> <em>Submitted On: </em> ${createdAt}</li>
                </ul>
            </li>`;
    };

    async function getWorkflowRequests() {
        try {
            const workflowRequests = await requestData({
                method: 'GET',
                url: `/clouds/AWS_ACCOUNT_ID/regions/REGION/workflows/requests`,
            });
            //- console.table(workflowRequests);
            if (!workflowRequests || workflowRequests.length === 0) {
                $('#workflowRequestsTable').html('<span class="text-warning">No requests submitted for resources in this cloud & region!</span>');
                return;
            }
            renderCollection(workflowRequests, 'createdAt', -1, workflowRequestItemTemplate, 'workflowRequestsTable', '530px');
        } catch(err) {
            console.error(err);
            $('#workflowRequestsTable').html('<span class="text-danger">Oops! Unable to fetch requests submitted for resources in this cloud & region!</span>');
        }
    }

    const workspacesTableColumns = [
        {
            header: 'WorkSpace ID',
            column: 'WorkspaceId',
            optional: true
        },
        {
            header: 'Assigned User',
            column: '', //'UserName',
            type :  'custom',
            template: ({ UserName, User: { EmailAddress } = {} }) => `${UserName} ${EmailAddress ? `<br/>(${EmailAddress})`  : ''}`
        },
        {
            header: 'Directory',
            column: '',
            type :  'custom',
            template: ({ Directory: { DirectoryId, DirectoryName } = {} }) => `${DirectoryName} <br/>(${DirectoryId})`,
            optional: true
        },
        {
            header: 'Bundle',
            column: '',
            type :  'custom',
            // template: ( { WorkspaceProperties: { ComputeTypeName } = {} }) => ComputeTypeName || 'Unavailable'
            template: ({ Bundle: { Name: BundleName } = {} }) => BundleName || 'Unavailable'
        },
        {
            header: 'Running Mode',
            column: '',
            type :  'custom',
            template: ({ WorkspaceProperties: { RunningMode, RunningModeAutoStopTimeoutInMinutes } }) => 
                `${RunningMode === 'AUTO_STOP' ? 'Auto-Stop' : 'Always-On'} ${RunningModeAutoStopTimeoutInMinutes ? ` <br/>${(RunningModeAutoStopTimeoutInMinutes / 60)} hour(s)` : ``} `,
            optional: true
        },
        {
            header: 'State',
            column: '',
            type: 'custom',
            template: ({ State }) => { const decor = State === 'AVAILABLE' ? 'text-success' : 'text-danger'; return `<span class="${decor}">${State}</span>`; }
        },
        {
            header: 'Actions',
            column: '',
            type :  'actions',
            template: ({WorkspaceId}) => {
                return `
            <div class="btn-group">
                <button type="button" class="btn btn-secondary btn-sm dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false">
                    Actions
                </button>
                <div class="dropdown-menu" class="actions-menu">
                    <a class="dropdown-item" data-workspace="${WorkspaceId}" data-confirm-action="false" data-action="start" href="#">Start</a>
                    <a class="dropdown-item" data-workspace="${WorkspaceId}" data-confirm-action="false" data-action="stop" href="#">Stop</a>
                    <a class="dropdown-item" data-workspace="${WorkspaceId}" data-confirm-action="true" data-action="reboot" href="#">Reboot</a>
                    <a class="dropdown-item" data-workspace="${WorkspaceId}" data-confirm-action="true" data-action="rebuild" href="#">Rebuild</a>
                    <a class="dropdown-item" data-workspace="${WorkspaceId}" data-confirm-action="true" data-action="remove" href="#">Remove</a>
                    <!-- <a class="dropdown-item disabled" data-workspace="${WorkspaceId}" data-action="backup" href="#"><s>Backup</s></a> -->
                </div>
            </div>`;
            }
        }
    ];

    const workspaceDetailsHeaderTemplate = ({WorkspaceId}) => {
        const workspaceHtml = `
            <li class="collection-item" style="text-align: left!important; border: none!important;">
                <ul class="collapsible">
                    <li data-workspace-id="${WorkspaceId}">
                        <div class="collapsible-header">
                            <i class="material-icons">list</i>Details
                            <span class="badge badge-white badge-pill text-white text-small">.</span>
                        </div>
                        <div class="collapsible-body">
                        </div>
                    </li>
                </ul>
            </li>`;
        return workspaceHtml;
    }
    
    const workspaceDetailsTemplate = (workSpacesItem) => {
        const { 
            WorkspaceId,
            ComputerName, IpAddress, 
            RootVolumeEncryptionEnabled, UserVolumeEncryptionEnabled, VolumeEncryptionKey,
            WorkspaceProperties: { RootVolumeSizeGib, UserVolumeSizeGib } = {},
            Connection: { ConnectionState, ConnectionStateCheckTimestamp, LastKnownUserConnectionTimestamp } = {},
            Bundle    : { BundleId, Name, Description } = {},
            User      : { EmailAddress, GivenName, Surname, OrganizationId, Username, Status } = {},
            Directory : { DirectoryId, DirectoryName, DirectoryType, RegistrationCode } = {},
            Tags = []
        } = workSpacesItem;

        const workspaceHtml = `
        <li class="collection-item" style="text-align: left!important; border: none!important;">
                <ul class="collapsible">
                    <li data-workspace-id="${WorkspaceId}" data-detailsloadedat="">
                        <div class="collapsible-header">
                            <i class="material-icons">list</i>Details
                            <span class="badge badge-white badge-pill text-white text-small">.</span>
                        </div>
                        <div class="collapsible-body">
                            <div class="row">
                                <div class="col md-5">
                                    <ul style="list-style-type:disc!important;">
                                        <li><span>Bundle Id: <em>${ BundleId}</em></span></li>
                                        <li><span>Bundle Name : <em>${ Name}</em></span></li>
                                        <li><span>Description : <em>${ Description}</em></span></li>
                                        <li><hr/></li>
                                        <li><span>Root Volume (GB): <em>${ RootVolumeSizeGib || 'Unavailable'}</em></span></li>
                                        <li><span>User Volume (GB): <em>${ UserVolumeSizeGib || 'Unavailable'}</em></span></li>
                                        <li><span>Encrypted Volumes : <em>
                                        ${ RootVolumeEncryptionEnabled ? ' Root ' : ''} 
                                        ${ (RootVolumeEncryptionEnabled && UserVolumeEncryptionEnabled) ? ' + ' : ''}
                                        ${ UserVolumeEncryptionEnabled ? ' User ' : ''} 
                                        ${ (!RootVolumeEncryptionEnabled && !UserVolumeEncryptionEnabled) ? 'None' : ''}
                                        </em></span></li>
                                        <li><span>Encryption Keys : <em>${ VolumeEncryptionKey || 'None' }</em></span></li>
                                    </ul>
                                </div>
                                <div class="col md-3">
                                    <ul style="list-style-type:disc!important;">
                                        <li><span>Directory ID : <em>${ DirectoryId}</em></span></li>
                                        <li><span>Directory Name : <em>${ DirectoryName}</em></span></li>
                                        <li><span>Directory Type : <em>${ DirectoryType}</em></span></li> 
                                        <li><hr/></li>
                                        <li><span>Registration Code : <em>${ RegistrationCode}</em></span></li>
                                        <li><span><a href="https://clients.amazonworkspaces.com/webclient" target="_blank" class="nav-ws-web-client">Launch Web Client</a></li>
                                    </ul>
                                </div>
                                <div class="col md-3">
                                    <ul style="list-style-type:disc!important;">
                                        <li><span>Username : <em>${ Username}</em></span></li>
                                        <li><span>Email : <em>${ EmailAddress}</em></span></li>
                                        <li><span>Name : <em>${ Surname}, ${GivenName}</em></span></li>
                                        <li><hr/></li>
                                        <li><span>Computer Name : <em>${ ComputerName || 'Unavailable'}</em></span></li>
                                        <li><span>Workspace IP : <em>${IpAddress || 'Unavailable'}</em></span></li>
                                        <li><span>ConnectionState : <em>${ ConnectionState || 'Unavailable'}</em></span></li>
                                        <li><span>User Last Active : <em>${ LastKnownUserConnectionTimestamp || 'Unavailable'}</em></span></li>
                                    </ul>
                                </div>
                            </div>
                            <div id="workspace-tags_${WorkspaceId}">
                            </div>
                        </div>
                    </li>
                </ul>
            </li>`;
        return workspaceHtml;        
    }

    const workspaceTagsTemplate = ({WorkspaceId, Tags}) => {
        const tags = Tags.sort((a, b) => a.Key > b.Key ? 1 : -1)
            .map(({ Key, Value }) => `<li style="list-style: inside!important;"><span>${Key} : <em>${Value}</em></span></li>`)
            .join('');
        return `
        <div id="workspace-tags_${WorkspaceId}">
            ${ tags ? `<hr/><span><i class="material-icons px-4">local_offer</i>Tags</span><hr/>
            <div class="row">
                <ul class="col md-6 offset-1">
                ${tags}
                </ul>
            </div>` : '' 
            }
        </div>`;
    } 

    const workspaceRowTemplate = (workSpacesItem) => {
        const workspacesItemRow = renderRows([workSpacesItem], workspacesTableColumns);
        const workspacesDetails = createCollectionContent([workSpacesItem], 'WorkspaceId', 1, workspaceDetailsTemplate, '');
        return `
            ${workspacesItemRow}
            <tr>
                <td colspan="${workspacesTableColumns.length}" style="border:none!important">
                    ${workspacesDetails}
                </td>
            </tr>
            <!--
            <tr style="border:thick black!important; height:2px!important;">
                <td colspan="${workspacesTableColumns.length}" >
                </td>
            </tr>
            -->
            `;
    }

    const ALL_WORKSPACES = [];
    async function getWorkspacesInfo() {
        try {
            const workspaces = await requestData({
                method: 'GET',
                url: `/clouds/AWS_ACCOUNT_ID/regions/REGION/workspaces`,
            });
            //- console.table(workSpaces);
            ALL_WORKSPACES.length = 0;
            ALL_WORKSPACES.push(...workspaces);
            renderWorkspaces(workspaces);
        } catch (err) {
            ALL_WORKSPACES.length = 0;
            console.error(err);
            $('#workspacesInfoTable').html(`<span class="text-danger">Oops! Unable to fetch Workspaces in this cloud & region! <br/> (${err.responseJSON.message})</span>`);
        } finally {
            initializeFilters(workspaceFilterFields, ALL_WORKSPACES);
        }
    }

    function renderWorkspaces(workspaces) {
        const headerRow = renderHeader(workspacesTableColumns);
        const itemRows = renderRows(workspaces, workspacesTableColumns, 'No workspaces assigned to you in this cloud & region', workspaceRowTemplate);
        const allRows = composeRows(headerRow, itemRows);
        const workspacesTable = renderTable(allRows, { border: true, small: true, hover: false });
        $('#workspacesInfoTable').html(workspacesTable);
        // initializeCollapsible('workspacesInfoTable', (e, index, collapsibleObject) => handleLoadWorkspaceDetails(collapsibleObject, e));
        initializeCollapsible('workspacesInfoTable', handleLoadWorkspaceDetails);
    }

    function handleLoadWorkspaceDetails(e, index, collapsibleObject) {
        // console.log(`: handleLoadWorkspaceDetails -> e, index, collapsibleObject`, e, index, collapsibleObject);
        const workspaceId = $(e).attr('data-workspace-id');
        const detailsLoadedAt = $(e).attr('data-detailsloadedat');
        // console.log(`: handleLoadWorkspaceDetails -> workspaceId, detailsLoadedAt`, workspaceId, detailsLoadedAt, Date.now());
        let reloadDetails = false;
        if (!detailsLoadedAt) {
            reloadDetails = true;
        } else {
            const detailsLoadedAtTimestamp = Number.parseInt(detailsLoadedAt);
            if (Date.now() - detailsLoadedAtTimestamp > 60 * 1000) {
                reloadDetails = true;
            }
        }
        if (reloadDetails) {
            // console.log(`Details data is stale, reloading...`);
            getWorkspacesDetails(workspaceId)
                .then(workspaceDetails => {
                    // console.log(`: handleLoadWorkspaceDetails -> workspaceDetails`, workspaceDetails);
                    renderWorkspaceDetails($(e), workspaceDetails);
                })
                .catch(err => console.error);
        }
    }

    function getWorkspacesDetails(workspaceId) {
        return requestData({
            method: 'GET',
            url: `/clouds/AWS_ACCOUNT_ID/regions/REGION/workspaces/${workspaceId}`,
        });
    }

    function renderWorkspaceDetails(detailsElement, workspaceDetails) {
        const { WorkspaceId } = workspaceDetails;
        const tagsElement = detailsElement.find(`#workspace-tags_${WorkspaceId}`);
        const tagsHtml = workspaceTagsTemplate(workspaceDetails);
        tagsElement.replaceWith(tagsHtml);
        detailsElement.attr('data-detailsloadedat', Date.now());
    }
    
    // mapper: (WorkspaceId, { User: { UserName, EmailAddress } }) => { return { Id: EmailAddress, Name: UserName, WorkspaceId}  },
    const workspaceFilterFields = [
        {
            marker: 'bundle',
            mapper: ({ WorkspaceId, Bundle: { BundleId, Name } = {} }) => { return { Id: BundleId, Name, WorkspaceId }; },
            selectTarget: 'filterWorkspaceBundle'
        },
        {
            marker: 'user',
            mapper: ({ WorkspaceId, User: { Username, EmailAddress } }) => { return { Id: Username, Name: Username, WorkspaceId } },
            selectTarget: 'filterWorkspaceUser'
        },
        {
            marker: 'directory',
            mapper: ({ WorkspaceId, Directory: { DirectoryId, DirectoryName } }) => { return { Id: DirectoryId, Name: DirectoryName, WorkspaceId }; },
            selectTarget: 'filterWorkspaceDirectory'
        }
    ];

    function initializeFilters(filterFields, workspaces) {
        if (workspaces.length > 1) {
            $('#workspacesInfoFilters').removeAttr('hidden').show('slow');
            // $('#workspacesInfoPager').removeAttr('hidden').show('slow');
        } else {
            $('#workspacesInfoFilters').hide('slow');
            // $('#workspacesInfoPager').hide('slow');
        }
        filterFields.forEach(({marker, mapper, selectTarget}) => {
            const filterValues = workspaces.map(mapper).map(({ Id, Name }) => `${marker} | ${Id} | ${Name}`);
            const distinctFilterValues = [...new Set(filterValues)];
            renderSelectOptions('filterBundle', distinctFilterValues, '', filterOptionTemplate, selectTarget);
            $(`#${selectTarget} option`).attr('selected', false);
            $(`#${selectTarget}`).off('change').on('change', (e) => handleFilterChange(e, marker, selectTarget));
            $(`#${selectTarget}`).formSelect();
        });
    }

    function handleFilterChange(e, marker, selectTarget) {
        console.log(`: handleFilterChange -> e, marker`, e, marker, $(`#${selectTarget}`).val());
        handleFilterWorkspaces();
    }

    function handleFilterWorkspaces(e) {
        e && e.preventDefault();
        const filteredIdSet = new Set();
        workspaceFilterFields.forEach(({ marker, mapper, selectTarget }) => {
            let selectedFilters = $(`#${selectTarget}`).val();
            selectedFilters.forEach(filterValue => {
                const temp = ALL_WORKSPACES.map(mapper).filter(({ Id }) => Id === filterValue).map(({ WorkspaceId }) => WorkspaceId);
                temp.forEach(t => filteredIdSet.add(t));
            });
        });
        if (filteredIdSet.size === 0) {
            renderWorkspaces(ALL_WORKSPACES);
        } else {
            const filteredSet = ALL_WORKSPACES.filter(({ WorkspaceId }) => filteredIdSet.has(WorkspaceId));
            renderWorkspaces(filteredSet);
        }
    }

    const filterOptionTemplate = (markerIdName) => {
        const [ marker, Id, Name ] = markerIdName.split(' | ');
        return defaultOptionTemplate({ valueProp: Id, textProp: Name, attrName:'workspace-filter', attrValue: marker });
    }

    async function handleWorkspaceAction(e) {
        e.preventDefault();
        const workspaceId   = $(e.target).attr('data-workspace');
        const action        = $(e.target).attr('data-action');
        const confirmAction = $(e.target).attr('data-confirm-action');
        const actionUpper = action.toUpperCase();
        if (confirmAction === 'true' && prompt(`Are you sure you want to ${actionUpper} the workspace ${workspaceId} ?

        This action may potentially cause loss of data from any current session and stored data from previous sessions!
        Please type ${actionUpper} below and click OK to confirm your request.`) !== actionUpper) {
            alert(`Confirmation not received, canceling the requested action (${action})!`);
            return false;
        };
        try {
            const result = await requestData({
                method: 'POST',
                url: `/clouds/AWS_ACCOUNT_ID/regions/REGION/workspaces/${workspaceId}/${action}`,
            });
            console.log(`: handleWorkspaceAction -> result`, result);
            const { FailedRequests: [{ ErrorMessage = '' } = {}] = [] } = result;
            alert(ErrorMessage || `Done! Request to ${action} your Workspace ${workspaceId} was submitted successfully.`, async () => {
                await getWorkspacesInfo();
            });
            
        } catch {
            console.error(e);
            alert(`<span>Oops! Unable to perform the ${action} action for the Workspace ${workspaceId} <br/><small>(JSON.stringify(e))</small></span>`);
        }
    }

    function initializeCollapsible(sectionSelector, onOpenStartCallback = null, onCloseStartCallback = null) {
        $(`#${sectionSelector} div.collapsible-header`)
            .append(`<i class="material-icons up-down-chevron">keyboard_arrow_down</i>`);
        $(`#${sectionSelector} ul.collapsible`).each((index, el) => {
            const collabsibleObject = $(el).collapsible({
            onOpenStart: (e) => {
                $(e).find('.up-down-chevron').text('keyboard_arrow_up');
                if (onOpenStartCallback && typeof onOpenStartCallback === 'function') {
                    onOpenStartCallback(e, index, collabsibleObject);
                }
            },
            onCloseStart: (e) => {
                $(e).find('.up-down-chevron').text('keyboard_arrow_down');
                if (onCloseStartCallback && typeof onCloseStartCallback === 'function') {
                    onCloseStartCallback(e, index, collabsibleObject);
                }
            }
            });
        });
    }

    $(function onDocReady() {
        // GLOBAL Ajax handlers to show/hide spinnner
        $(document)
            .ajaxStart(function() {
                $("#loadDiv").removeAttr('hidden').show();
            })
            .ajaxSend(( event, jqxhr, settings ) => {
                // console.log('ajaxSend', event, jqxhr, settings);
            })
            .ajaxStop(function () {
                $("#loadDiv").hide();
                // .attr('hidden', true)
            });

        $('.auth-message').hide();
        $('.instance-message').hide();
        $('.user-message').hide();
        $('.vpnaccess-message').hide();
        $('#loadDiv').hide();
        $('#createWorkflowForm select').formSelect();
        $('#requestWorkflowForm select').formSelect();
        $('[data-toggle="tooltip"]').tooltip();
        // https://getbootstrap.com/docs/4.3/components/popovers/#options
        $('body').popover({
            title: 'details',
            selector: '[data-toggle="popover"]',
            html: true,
            placement: 'bottom',
            trigger: 'hover click'
        });

        // Hook up functions to forms' submit buttons.
        if (COGNITO_USERPOOL_ENABLED) {
            // check if we're already logged in?
            // try {
                // const cognitoUser = await getCurrentAuthUser();
                getCurrentAuthUser().then(cognitoUser => {
                    // console.log(`Already logged in...`, cognitoUser);
                    const { tokenEmail, appRole } = getUserInfoFromAuthTokens(cognitoUser.signInUserSession);
                    handleAuthSuccess(tokenEmail, appRole);
                })
            // } catch (reason) {
            .catch (reason => {
                console.info(`Not logged in`, reason);
                $('.unauthenticated').removeAttr('hidden').show();
                $('.authenticated').hide();
                $('#emailInputSignin').trigger('select').trigger('focus');
                // toggle password visibility
                $("#show_hide_password i").off('click').on('click', function(event) {
                    event.preventDefault();
                    if($('#show_hide_password input').attr("type") == "text"){
                        $('#show_hide_password input').attr('type', 'password');
                        $('#show_hide_password i').text("visibility");
                    } else if($('#show_hide_password input').attr("type") == "password"){
                        $('#show_hide_password input').attr('type', 'text');
                        $('#show_hide_password i').text("visibility_off");
                    }
                });       
            });
            $('#signinForm').off('submit').submit(handleCognitoAuthentication);
        } else {
            $('#signinForm').off('submit').submit(handleAuthentication);
        }

        /** INSTANCES ACCESS HANDLERS */
        $('#cloudSelector').off('change').on('change', handleCloudChange);
        $('#regionSelector').off('change').on('change', handleRegionChange);
        $('#refreshInstances').off('click').on('click', getInstancesInfo);
        $('#refreshs3Buckets').off('click').on('click', getS3BucketsInfo);
        const intervalId = setInterval(function () {
            if (API_KEY) {
                getInstancesInfo();
                getS3BucketsInfo();
            }
        }, REFRESH_INTERVAL_MINUTES * 60 * 1000);
        $('#instancesInfoTable').off('click').on('click', 'a', handleInstanceAction);

        /** USER ACCESS HANDLERS */
        $('#refreshUsers').off('click').on('click', e => {
            $('.user-message').hide();
            getUsers();
        });
        $('#usersInfoTable').off('click').on('click', 'a', (userActionEvent) => {
            handleUserAction(userActionEvent);
        });
        $('#launchAddNewUserModal').off('click').on('click', e => {
            e.preventDefault();
            $('#addNewUserForm').trigger('reset');
            $('#addnewuser-message').text('');
            $('#addNewUserModal').modal({
                show: true,
                backdrop: 'static',
                keyboard: false
            });
        });
        $('#addNewUserSubmit').off('click').on('click', addNewUserEvent => {
            handleAddNewUser(addNewUserEvent);
        });
        
        /** VPN ACCESS HANDLERS */
        $('#refreshVpnAccess').off('click').on('click', getVpnAccessInfo);
        $('#vpnAccessInfoTable').off('click').on('click', 'a', handleVpnAccessAction);
        
        /** USER PROFILE HANDLER */
        $('#userProfile').off('click').on('click', (e) => {
            e.preventDefault();
            // const userProfileInfoEl = document.querySelector('#userProfileInfo');
            // const userProfileInfo = M.Collapsible.init(userProfileInfoEl, {
            //     accordion: true,
            //     // onOpenStart: (li) => {
            //     //     // }
            //     // }
            // });
            $('#editProfileTags').off('click').on('click', handleUpdateUserTags);
            handleLoadUserProfile();
        });

        // $('#updateMfaOptions').off('click').on('click', (e) => {
        //     e.preventDefault();
        //     alert(`Updating MFA...`);
        //     handleConfigureMFA()
        // });

        $('#verifyMFAcode').off('click').on('click', (e) => {
            e.preventDefault();
            alert(`Verifying Code...`);
            handleVerifyMFA()
        });

        $('#mfaChoiceTOTP').off('change').on('change', (e) => {
            handleToggleMFA();
        });
        initializeCollapsible('userProfileContainer');

        /** timeago jquery plugin config */
        jQuery.timeago.settings.strings.inPast = 'Expired!';
        jQuery.timeago.settings.allowPast = false;
        jQuery.timeago.settings.allowFuture = true;

        $('#remoteAccessModal').on('hidden.bs.modal', async (e) => {
                await getInstancesInfo();
                // return false;
        });


        /** TENANT CONFIG HANDLER */
        $('#tenantConfig').off('click').on('click', initializeTenantConfigInfo);
        $('#tenantConfigCloudsTable').off('click').on('click', 'a:not(.nav-iam-console)', handleCloudConnectionAction);
        $('#editTenantConfigClouds').off('click').on('click', (e) => {
            e.preventDefault();
            initializeCloudsForm({mode: 'addCloud'});
        });
        initializeCollapsible('tenantConfigContainer');
        $('#inviteUser').off('click').on('click', initializeInviteNewUserForm);
        $('#inviteNewUserForm').off('submit').on('submit', handleInviteNewUserFormSubmit);

        /** WORKFLOW HANDLERS */
        $('#workflowsInfoTable').off('click').on('click', '.workflow-action', handleWorkflowAction);
        $('#inputResourceType').off('change').on('change', handleLoadWorkflowParams);
        initializeCollapsible('pills-workflowAdmin');
        // $('#pills-workflowAdmin-tab').on('shown.bs.tab', (e) => {
        //     $('#inputResourceType').val('EC2').trigger('change');
        // });
        $('#resolveEc2ImageList').off('click').on('click', handleResolveEc2ImageList);
        $('#resolveWorkspacesList').off('click').on('click', handleResolveWorkspacesBundleList);
        $('#applyLease').off('change').on('change', (e) => {
            const applyLease = $('#applyLease').is(':checked');
            bindLeaseSection({ applyLease });
        });
        $('#allowVolumes').off('change').on('change', (e) => {
            const allowVolumes = $('#allowVolumes').is(':checked');
            if (allowVolumes) {
                $('#ec2ParamsStorageTable').show('slow');
                $('#maxVolumeCount').prop('disabled', false).val(1);
            } else {
                $('#ec2ParamsStorageTable').hide('slow');
                $('#maxVolumeCount').prop('disabled', true).val(null);
            }
            $('.item-check-volumetype').prop('checked', false);
            updateCounters();
        });
        // $('#filterWorkspaces').off().on('click', handleFilterWorkspaces);

        $('#paramsApproversOptionsList input[name=paramsApproversOptions]').off().on('change', handleApproverOptionsChange)
        $('#saveWorkflow').off('click').on('click', handleSaveWorkflow);
        // $('#selectSavedWorkflows').off('change').on('change', handleSelectWorkflow);
        // $('#addVolume').off('click').on('click', handleAddVolume);
        $('#workflowJustification').characterCounter();
        $('#submitWorkflowRequest').off('click').on('click', handleSubmitWorkflowRequest);
        $('#checkWorkflowRequestPricing').off('click').on('click', { pricing: true }, handleSubmitWorkflowRequest);
        $('#requestWorkflowForm').off()
            .on('submit', handleSubmitWorkflowRequest)
            .on('reset', resetWorkflowRequestForm);
        $('#refreshWorkflows').off().on('click', getWorkflowsList);
        $('#refreshWorkflowRequests').off().on('click', getWorkflowRequests);
        
        $('#showDashboard').off('click').on('click', async (e) => {
            await fetchCloudsAndRegions();
            $('.profile').hide();
            $('.config').hide();
            $('.authenticated').show();
        });
        
        /** WORKSPACES HANDLER */
        $('#refreshWorkspaces').off().on('click', getWorkspacesInfo);
        $('#workspacesInfoTable').off('click').on('click', 'a:not(.nav-ws-web-client)', handleWorkspaceAction);
        
        /** SIGN OUT HANDLER */
        $('#signOut').click(e => {
            e.preventDefault();
            if (COGNITO_USERPOOL_ENABLED) {
                userSignOut(USER_NAME)
                    .then(signedOut => {
                        console.log('signed out succesfully', signedOut);
                    })
                    .catch(e => {
                        console.error('error signing out', e);
                    })
                    .finally(_ =>  reloadPage());
            } else {
                reloadPage();
            }
        });

        function reloadPage() {
            console.log('reloading page...');
            API_KEY = null;
            USER_NAME = null;
            USER_ROLE = null;
            USER_ISADMIN = null;
            // $('.unauthenticated').show();
            // // $('body').not('.unauthenticated').hide();
            // $('.authenticated').hide();
            // $('.profile').hide();
            window.location.reload(true);
        }
    });

}(jQuery));
