
const {
	doc: docClient,
	raw: dynamodb,
	conv: converter
} = require('./ddbClient')({ convertEmptyValues: true });

const {
	ok,
	badRequest,
	fail
} = require('./response');

const TenantsController = require('./tenants');
const tenantsController = new TenantsController();

const CloudsController = require('./clouds');
const cloudsController = new CloudsController();

const Ec2ClientManager = require('./ec2Client');
const clientManager = new Ec2ClientManager();

const RoutingController = require('./routing');
const routingController = new RoutingController();

const SchedulesTableInfo = {
	TableName: process.env.SchedulesDDBTableName,
	HashKey  : 'contextKey',
	RangeKey : 'objectKey'
}

module.exports.scheduleExpiration = async ({ tenantId, accountId, region, objectKey, leaseOptions, additionalInfo = {} }) => {
	try {
		const { leaseDuration, leaseDurationUnit } = leaseOptions;
		const timestamps = getExpirationEpoch({ duration: leaseDuration, durationUnit: leaseDurationUnit });
		const instanceTerminationScheduled = await docClient.put({
			TableName: SchedulesTableInfo.TableName,
			Item: {
				[SchedulesTableInfo.HashKey]: createContextKey(tenantId, accountId, region),
				[SchedulesTableInfo.RangeKey]: objectKey,
				...timestamps,
				leaseOptions,
				...additionalInfo
			}
		}).promise();
		console.log(`instanceTerminationScheduled`, instanceTerminationScheduled);
		return `Successfully scheduled the requested expiration for ${objectKey}. ${JSON.stringify(leaseOptions)}`;
		return true;
	}
	catch (err) {
		console.error(`scheduleTermination ->`, JSON.stringify(err));
		return `Error scheduling the requested expiration. ${err.message}`;
		return false;
	}
}

module.exports.scavenger = async (event, context) => {
	console.log(`: module.exports.handler -> event`, JSON.stringify(event));
	try {
		for (const record of event.Records) {
			console.log('Stream record: ', JSON.stringify(record, null, 2));

			if (record.eventName == 'REMOVE') {
				const { Keys, OldImage } = record.dynamodb;
				const { contextKey, objectKey } = converter.unmarshall(Keys);
				const { leaseOptions, resourceType } = converter.unmarshall(OldImage);
				console.log(`: module.exports.handler -> contextKey, objectKey, leaseOptions`, contextKey, objectKey, leaseOptions);

				const {
					leaseAction,
					leaseDuration,
					leaseDurationUnit,
				} = leaseOptions;

				console.log(`: module.exports.handler ->
                    leaseAction,
                    leaseDuration,
                    leaseDurationUnit,`,
					leaseAction,
					leaseDuration,
					leaseDurationUnit);

				const [tenantId, accountId, region] = contextKey.split('_');
				console.log(`: module.exports.handler -> tenantId, accountId, region`, tenantId, accountId, region);

				cloudsController.init({ tenantId });
				const cloud = await cloudsController.getCloud(accountId);
				const ec2Client = await clientManager.getEc2Client({ cloud, region, service: 'EC2' });
				if (resourceType === 'SubnetRouting') {
					await routingController.init({ cloud, region });
				}

				switch (`${resourceType} ${leaseAction}`) {
					case 'EC2 terminate':
						const terminated = await ec2Client.terminateInstances({
							InstanceIds: [objectKey]
						}).promise();
						console.log(`: module.exports.handler -> terminated`, terminated);
						// return terminated;
						break;
					case 'EC2 shut-down':
						const shutdown = await ec2Client.stopInstances({
							InstanceIds: [objectKey]
						}).promise();
						console.log(`: module.exports.handler -> shutdown`, shutdown);
					// return shutdown;
					case 'SubnetRouting public':
						await routingController.deleteInternetRoute({ instanceId: objectKey });
						break;
					case 'SubnetRouting private':
						await routingController.createInternetRoute({ instanceId: objectKey });
							break;
					default:
						console.error(`Invalid action configured for leaseAction`, leaseAction);
						break;
				}
				// notify requester of launch outcome
				// const { subject, mailBody } = composeLeaseActionMail(requester, instanceId, leaseOptions);
			}
		}
	} catch (err) {
		// TODO: send message to DLQ or SNS topic for processing
		console.error(`Scheduled execution failed!`, err);
	}
}

module.exports.handler = async (event, context) => {
	console.log(`:: module.exports.handler -> event`, event);
	try {
		const { tenantId, tenantValid, tenantMessage } = await tenantsController.validateTenant(event);
		if (!tenantValid) {
			return badRequest({ message: tenantMessage });
			// } else {
			//     cloudsController.init({ tenantId });
			// const cloud = await cloudsController.getCloud(accountId);
		}
		const { accountId, region, objectKey, resourceType } = (event && event.pathParameters) || {};
		const methodResource = `${event.httpMethod} ${event.resource}`;
		console.log('methodResource', methodResource);
		switch (methodResource) {
			case 'GET /clouds/{accountId}/regions/{region}/schedules/{objectKey}/{resourceType}':
				const instanceSchedule = await exports.querySchedule({ tenantId, accountId, region, objectKey, resourceType });
				return ok(instanceSchedule);
			default:
				return badRequest({ message: `Invalid resource requested` });
		}
	}
	catch (err) {
		console.error(err);
		return fail(err);
	}
}

module.exports.querySchedule = async ({ tenantId, accountId, region, objectKey, resourceType }) => {
	console.log(`:: querySchedule -> tenantId, accountId, region, instanceId, resourceType`, tenantId, accountId, region, objectKey, resourceType);
	const instanceSchedules = await docClient.query({
		TableName: SchedulesTableInfo.TableName,
		KeyConditionExpression: `${SchedulesTableInfo.HashKey} = :c AND ${SchedulesTableInfo.RangeKey} = :o`,
		FilterExpression: `resourceType = :r`,
		ExpressionAttributeValues: {
			':c': createContextKey(tenantId, accountId, region),
			':o': objectKey,
			':r': resourceType
		}
	}).promise();

	let instanceSchedule;
	if (instanceSchedules.Count === 0) {
		instanceSchedule = {};
	} else if (instanceSchedules.Count === 1) {
		instanceSchedule = instanceSchedules.Items[0];
		const { leaseOptions, expirationTime } = instanceSchedule;
		console.log(`:: module.exports.querySchedule -> expirationTime, Date.now()/1000`, expirationTime, Date.now()/1000);
		if (expirationTime < Date.now()/1000) {
			instanceSchedule = {};
		} else {
			instanceSchedule = { ...leaseOptions, expirationTime };
		}
	} else {
		throw new Error({ message: `Expected single schedule record for objectKey: ${objectKey} and resourceType: ${resourceType}. Found: ${instanceSchedules.Count}` });
	}
	return instanceSchedule;
}

function getExpirationEpoch({ start = Date.now(), duration, durationUnit }) {
	const { addMinutes, addDays, addHours, addWeeks, addMonths } = require('date-fns');
	let expirationEpoch;
	switch (durationUnit) {
		case 'mi':
			expirationEpoch = addMinutes(start, duration);
			break;
		case 'hh':
			expirationEpoch = addHours(start, duration);
			break;
		case 'dd':
			expirationEpoch = addDays(start, duration);
			break;
		case 'wk':
			expirationEpoch = addWeeks(start, duration);
			break;
		case 'mo':
			expirationEpoch = addMonths(start, duration);
			break;
		default:
			return null;
	}
	return {
		startTime: start / 1000,
		startTimeISO: new Date(start).toISOString(),
		expirationTime: expirationEpoch.valueOf() / 1000,   // DDB TTL 
		expirationTimeISO: expirationEpoch.toISOString()
	};
}

function createContextKey(tenantId, accountId, region) {
	return `${tenantId}_${accountId}_${region}`;
}