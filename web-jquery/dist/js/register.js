'use strict';

import  
{
    alert,
    uuidv4,
    rolePolicy,
    objectifyForm,
    getApiBaseURL,
    getRoleARNPrefix,
    getHostingAccount,
    getRoleConsolePath,
    getCloudFormationURL,
    getCloudAccountConfig,
    GovCloudAccountType,
    PubCloudAccountType,
} from './clientConfig.js';

import { userSignUp } from './cognitoModule.js';


(function($) {
    
    let TENANT_ID;
    let API_BASE_URL = getApiBaseURL();
    console.log(`: API_BASE_URL`, API_BASE_URL);

    $(function onDocReady() {

        $('.getStarted').on('click', (e) => {
            window.location = 'index.html';
        });

        $('#buttonRegisterIndividual, #buttonRegisterCompany').click((e) => {
            const stepperIndividual = 'ul.mdl-stepper#stepper-individual';
            const stepperCompany = 'ul.mdl-stepper#stepper-company';
            let stepperContext, stepperShow, stepperHide;
            if (e.target.id === 'buttonRegisterIndividual') {
                stepperContext = 'individual';
                stepperShow = stepperIndividual;
                stepperHide = stepperCompany;
            } else if (e.target.id === 'buttonRegisterCompany') {
                stepperContext = 'company'
                stepperShow = stepperCompany;
                stepperHide = stepperIndividual;
            }
            initializeStepper(stepperContext, stepperShow, stepperHide);
        });
        
        let Stepper;
        function initializeStepper(stepperContext, stepperShow, stepperHide) {
            // console.log(stepperContext, stepperShow, stepperHide);
            const stepperElement = document.querySelector(stepperShow);
            if (typeof componentHandler !== 'undefined') { // Check if MDL Component Handler is loaded.
                componentHandler.upgradeElement(stepperElement);
            } else {
                // Material Design Lite javascript is not loaded?
                return false;
            }
            Stepper = stepperElement.MaterialStepper;
            Stepper.goto(1);
            loadTemplates(stepperShow);
            initializeCloudsForm();
            initializePeopleForm(stepperContext);
            // $('#createCompanyForm').off('submit').on('submit', { stepperContext }, handleCreateTenant);
            // $('#createUsersForm').off('submit').on('submit', { stepperContext }, handleUserSignUp);

            $('#createCompanyForm').off('submit').on('submit', { stepperContext }, handleCreateTenant);
            $('#createUsersForm').off('submit').on('submit',{ stepperContext }, (e) => {
                const { stepperContext } = e.data;
                // console.log('createUsersForm_submit', stepperContext);
                
                if (stepperContext === 'individual') { // for individual account, force tenat creation upon user creation.
                    $("#inputUserRoleAdmin").attr('checked', 'checked'); // assign individual as Admin
                    handleCreateTenant(e).then(_ => {
                        console.log(TENANT_ID);
                        handleUserSignUp(e);
                    });
                } else {
                    handleUserSignUp(e);
                }
            });

            $('#registerCards').hide();
            $(`${stepperHide}`).show();
            $(`${stepperShow}`).removeAttr('hidden')
            $(`${stepperShow}`).show();
        }

        $('.mdl-step').on({
            onstepback: (e) => {
                // console.log('moved back', Stepper.getActive(), e.target['data-template']);
                Stepper.back();
            },
            onstepnext: (e) => {
                // loadStepTemplate();
                // console.log('moved next');
                Stepper.next();
            },
            onstepcancel: (e) => {
                console.log('cancel requested');
                if (confirm(`Are you sure you'd like to cancel?`)) {
                    console.log('cancelled');
                    if (TENANT_ID) {
                        handleCancelRegistration(e);
                    }
                    window.location.reload(true);
                }
            },
            onstepcomplete: (e) => {
                // console.log('completed', e);
            }, 
            onsteperror: (e) => {
                console.error('Uh-oh!!', e);
            }
        });

        function loadTemplates(stepperId) {
            $(`${stepperId} li[data-template]`).each((index, li) => {
                // console.log(li, $(li).attr('data-template'));
                loadStepTemplate($(li));
            });
        } 

        function loadStepTemplate(activeStep = $(Stepper.getActive())) {
            const dataTemplate = activeStep.attr('data-template');
            const activeStepContent = activeStep.children('div.mdl-step__content');
            if (dataTemplate && activeStepContent) {
                activeStepContent.html($('#' + dataTemplate).html());
                //disable all the Continue buttons initially
                activeStep.find('div.mdl-step__actions  button[data-stepper-next]')
                    .removeClass()
                    .addClass('btn btn-default btn-primary disabled')
                    .attr('disabled', true); //
                $('select').formSelect();  
            }
        }

        // $(window).off('beforeunload').on('beforeunload', function(){ 
        //     return 'Leaving?';
        // });
    });

    function activateContinue(stepName) {
        let buttonToActivate;
        switch(stepName) {
            case 'companyCreated':
                buttonToActivate = 'continueCompanyCreated';
                break;
            case 'peopleCreated':
                buttonToActivate = 'continuePeopleCreated';
                break;
            case 'peopleCreated_Ind':
                buttonToActivate = 'continuePeopleCreated_Ind';
                break;
            case 'cloudsCreated':
                buttonToActivate = 'continueCloudsCreated'
                break;
            case 'cloudsCreated_Ind':
                buttonToActivate = 'continueCloudsCreated_Ind'
                break;
            default:
                return;
        }
        $(`#${buttonToActivate}`).removeAttr('disabled').removeClass('disabled');
    }

    async function handleCreateTenant(e) {
        e.preventDefault();

        return new Promise((resolve, reject) => {

            const { stepperContext } = e.data;
            console.log('handleCreateTenant', { stepperContext });

            let tenantInfo = {};
            if (stepperContext === 'company') {
                tenantInfo = objectifyForm($(this));
            }
            tenantInfo = Object.assign(tenantInfo, { registrationType: stepperContext });

            $.ajax({
                async: false,
                method: 'POST',
                url: `${API_BASE_URL}/registration/tenant`,
                beforeSend: function () {
                    $('loadDiv').show();
                },
                complete: function () {
                    $('loadDiv').hide();
                },
                data: JSON.stringify(tenantInfo),
                contentType: 'application/json',
                error: function (xhr, status, err) {
                    console.log(xhr.responseText, status, err);
                    reject(xhr.responseText);
                },
                success: function ({ tenantId }) {
                    TENANT_ID = tenantId;
                    if (stepperContext === 'company') {
                        $('#inputTenantId').val(tenantId);
                        alert(`Company profile created!`, () => alert(`Let's get your team set up next!`));
                        $('#createCompanyForm :input').attr('disabled', true);
                        activateContinue('companyCreated');
                    }
                    resolve(TENANT_ID);
                }
            });
        });
    }

    function handleUserSignUp(e) {
        e.preventDefault();
        const { stepperContext } = e.data;

        const { isValid, userFormData, userRow } = validatePeopleForm(false);
        if (!isValid) return false;

        userSignUp(userFormData)
            .then(({firstName, userEmail}) => {
                if (stepperContext === 'individual') {
                    alert(`Hey ${firstName}, we've created your account and sent you a sign-in code to your email ${userEmail}.`, 
                        () => alert('Go ahead and start connecting to your cloud services!')
                    );
                    $('#createUsersForm :input').attr('disabled', true);
                    activateContinue('peopleCreated_Ind');
                } else {
                    alert(`User account for ${firstName} created! <br/> Verification code sent to ${userEmail}.`, 
                    () => alert('Go ahead, you can add more users, <br/> or start connecting clouds!')
                    );
                    $('#userAccountList')
                    .append(userRow)
                    .parent().removeAttr('hidden');
                    
                    $('#createUsersForm').trigger('reset');
                    $('#createUsersForm button[type="submit"]').text('Add another user');
                    $('#createUsersForm hidden').val('');
                    initializeUserTagsChips();
                    activateContinue('peopleCreated');
                }
            })
            .catch(e => {
                console.error('Problem creating Cognito user', e);
                alert(`<span>Uh-oh! We've hit a problem setting up the user account. Please check and retry. <br/> <small>(${e.message})</small></span>`);
            });
    }
    
    function initializePeopleForm(stepperContext) {
        if (stepperContext === 'company') {
            $('#add-people-template-lead').text(`Now...Let's add some Users and determine who's who!`);
        } else {
            $('#add-people-template-lead').text(`Please tell us about yourself...`);
            $('#add-people-template-role').hide();
        }

        $('#inputEmailVerify, #inputPasswordVerify, #inputEmail, #inputPassword')
            .on('blur change', () => validatePeopleForm(true));

        // initialize the Chips component for User Tags
        initializeUserTagsChips();
    }

    function initializeUserTagsChips() {
        const chipsElement = document.querySelector('#chipsUserTags');
        const chipsUserTags = M.Chips.init(chipsElement, {
            placeholder: 'Enter a tag in format TagName = Value (e.g. Team = IT or Project = Portal)',
            secondaryPlaceholder: 'TagName = Value',
            limit: 5,
            // data: [{
            //     tag: 'Team = DevOps',
            // }, {
            //     tag: 'Project = Portal',
            // }],
            // autocompleteOptions: {
            //     data: {
            //         'Team': null,
            //         'Project': null,
            //     },
            //     limit: Infinity,
            //     minLength: 1
            // },
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
                    $('#inputUserChips').val(chipText).trigger('focus');
                    buildUserTags(chipsUserTags.chipsData);
                    // return false;
                } else {
                    // console.log('VALID');
                    buildUserTags(chipsUserTags.chipsData);
                    $('#inputUserChips').val('').removeClass('invalid');
                    // return true;
                }
            },
            onChipDelete: (c, d) => {
                // console.log('DELETED', chipsUserTags.chipsData, c, d);
                buildUserTags(chipsUserTags.chipsData);
            },
            onChipSelect: (c, data) => {
                const chipText = data.childNodes[0].textContent;
                const allChips = chipsUserTags.chipsData.map(c => c.tag);
                const tagIndex = allChips.indexOf(chipText);
                chipsUserTags.deleteChip(tagIndex);
                $('#inputUserChips').val(chipText).focus();
            }
        });
        // add chip on tab-out.
        $('#inputUserChips').off('blur').on('blur', () => {
            const chipData = $('#inputUserChips').val();
            $('#inputUserChips').val(''); //.focus();
            chipsUserTags.addChip({
                tag: chipData
            });
        });
    }
    
    function buildUserTags(chipsData) {
        // console.log(chipsData);
        const awsTagsFormat = chipsData.map(c => {
            const splitArray = c.tag.split('=');
                return {
                    Name: `tag:${splitArray[0].trim()}`,
                    Values: [ splitArray[1].trim() ]
                }
        });
        const awsTagsFormatString = JSON.stringify(awsTagsFormat);
        // console.log(awsTagsFormatString);
        $('#hiddenAwsUserTags').val(awsTagsFormatString);
    }

    function parseUserTags(awsTagsFormatString) {
        const tagsArray = JSON.parse(awsTagsFormatString);
        const parsed = tagsArray.map(t => {
            return {
                name: t.Name.split('tag:')[1],
                values0: t.Values[0]
            }
        })
        .map(nv => `${nv.name} = ${nv.values0}`)
        .join(' | ');
        // console.log(awsTagsFormatString, parsed);
        return parsed;
    }

    function validatePeopleForm(validateEmailPasswordOnly = false) {

        let isValid = true;
        if ($('#inputPassword').val() !==  $('#inputPasswordVerify').val()) {
            // alert(`passwords don't match!`);
            $('#inputPasswordVerify').addClass('invalid');
            isValid = false;
        } else {
            $('#inputPasswordVerify').removeClass('invalid');
        }
        if ($('#inputEmail').val() !==  $('#inputEmailVerify').val()) {
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

        const firstName = $('#inputFirstName').val();
        const lastName  = $('#inputLastName').val();
        const userEmail = $('#inputEmail').val();
        const appRole   = $('input[name=inputUserRole]:checked').val();
        const password  = $('#inputPassword').val();
        const userTags  = $('#hiddenAwsUserTags').val();
        let userRow;

        // console.log(userEmail, password, firstName, lastName, appRole, TENANT_ID, userTags);
        if (!TENANT_ID) {
            alert(`We're sorry, looks like something went wrong! <br/> Please restart the registration.`);
            return { isValid: false };
        }
        
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
            userFormData: { userEmail, password, firstName, lastName, appRole, tenantId: TENANT_ID, userTags },
            userRow
        };
    }

    function handleCloudsConnection(e, onlyTestConnection = false) {
        e.preventDefault();

        const { isValid, cloudData, cloudRow } = validateCloudConnection();
        if (!isValid) return false;

        $.ajax({
            method: 'POST',
            url: `${API_BASE_URL}/registration/connectclouds?test=${onlyTestConnection}`,
            data: JSON.stringify(cloudData),
            contentType: 'application/json'
        }).catch(function (xhr, status, err) {
                console.log(xhr.responseText, status, err);
        }).then( function({connectionValid, message, tenantId, accountId}) {
                if (!connectionValid) {
                    console.error(message);
                    alert(`Uh-oh, there seems to be a problem connecting to your account. Please check and retry! <br/> ( ${message} )`);
                    return false;
                }
                if (onlyTestConnection) {
                    alert('Cloud connection looks good! <br/> Please Save and proceed.');
                    return true;
                }
                alert('Cloud connection successfully saved!', 
                    () => alert('Keep going, you can connect more clouds!')
                );
                $('#cloudConnectionsList')
                    .append(cloudRow)
                    .parent().removeAttr('hidden');
                
                activateContinue('cloudsCreated');
                activateContinue('cloudsCreated_Ind');

                initializeCloudsForm();

                // $('#createCloudsForm button[type='submit']').text('Add another cloud');
        });        
    }

    function initializeCloudsForm() {
        $('#createCloudsForm').trigger('reset').off('submit').on('submit', handleCloudsConnection);
        const externalID = uuidv4();
        $('#inputExternalID').val(externalID);

        $('#inputTenantAccountType').off('change').on('change', (e) => {
            const isGovCloud = $('#inputTenantAccountType').is(':checked');
            const accountType = isGovCloud ? GovCloudAccountType : PubCloudAccountType;
            const hostingAccountId = getHostingAccount(accountType);
            $('#inputHostingAccount').val(hostingAccountId);  // pre-populate the hosting account
            API_BASE_URL = getApiBaseURL(accountType);
            console.log(`: initializeCloudsForm -> API_BASE_URL`, API_BASE_URL);
        }).prop('checked', false).trigger('change');

        $('#setupCloudAccountAccess').off('click').on('click', (e) => {
            const cloudName    = $('#inputConnectionName').val();
            const cloudAccount = $('#inputTenantAccount').val();
            const isGovCloud   = $('#inputTenantAccountType').is(':checked');
            const accountType  = isGovCloud ? GovCloudAccountType : PubCloudAccountType;
            // const { isValid }  = validateCloudConnection(true);
            // if (!isValid) return false;
            const proceed      = confirm(`You will be redirected to login to AWS CloudFormation in your account (${cloudAccount}).\nPlease complete the Role Policy setup and resume back here.`);
            if (proceed) {
                const cloudFormationURL = getCloudFormationURL(externalID, cloudName, accountType);
                window.open(cloudFormationURL);
            }
        });
        $('#testCloudAccountAccess').off('click').on('click', (e) => {
            handleCloudsConnection(e, true);
        });

        $('#inputRolePolicy').text(rolePolicy);
        M.updateTextFields();
        // M.textareaAutoResize($('#inputRolePolicy'));
    }
    
    function validateCloudConnection(partial = false) {
        let isValid = true;
        
        if (!TENANT_ID) {
            alert(`We're sorry, looks like something went wrong! <br/> Please restart the registration.`);
            isValid = false;
        }
        const cloudName     = $('#inputConnectionName').val();
        const externalId    = $('#inputExternalID').val();
        const accountId     = $('#inputTenantAccount').val();
        // if (partial) {
        //     if (!cloudName) {
        //         $('#inputConnectionName').val
        //     }
        //     return isValid;
        // }
        const isGovCloud    = $('#inputTenantAccountType').is(':checked');
        const accountType   = isGovCloud ? GovCloudAccountType : PubCloudAccountType;
        const accountConfig = getCloudAccountConfig(accountType);
        const roleARN       = $('#inputCrossAccountRoleARN').val();
        const cloudRow      = `<tr><th scope="row">${cloudName}</th><td>${accountId}</td><td>${externalId}</td><td>${roleARN}</td><td>${accountConfig.display}</td></tr>`;

        const cloudData = {
            cloudName,
            accountId,
            externalId,
            roleARN,
            accountType,
            tenantId: TENANT_ID
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
    
    function handleCancelRegistration(e) {
        e.preventDefault();
        $.ajax({
            async: false,
            method: 'POST',
            url: `${API_BASE_URL}/registration/cancel`,
            data: JSON.stringify({tenantId: TENANT_ID}),
            contentType: 'application/json'
        }).catch(function (xhr, status, err) {
                console.log(xhr.responseText, status, err);
            }).then( function({tenantId, status}) {
                TENANT_ID = null;
                $('#inputTenantId').val('');
            });
    }

}(jQuery));



