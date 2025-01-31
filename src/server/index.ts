import { PrismaClient } from '@prisma/client';
import express from 'express';
import { authenticateClient } from './auth';
import { WebSocket } from 'ws';
import { Redis } from 'ioredis';

const prisma = new PrismaClient();
const router = express.Router();

interface Site {
	id: string;
	name: string;
	location: string;
	clientId: string;
	vpnAddress: string;
}

interface MiningUnit {
	id: string;
	siteId: string;
	controlBoardId: number;
	minerCount: number;
	status: 'active' | 'inactive' | 'maintenance';
}

interface DeviceReading {
	deviceId: number;
	siteId: string;
	timestamp: string;
	data: {
		hashRate?: number;
		temperature?: number;
		fanSpeed?: number;
		powerConsumption?: number;
		energyReading?: number;
		heatMeterReading?: number;
	};
}

interface Command {
	type: 'restart' | 'updateConfig' | 'shutdown';
	deviceId: number;
	siteId: string;
	parameters?: Record<string, any>;
}

interface DeviceStatus {
	deviceId: number;
	status: 'online' | 'offline' | 'error';
	lastSeen: string;
	errorMessage?: string;
}

interface SiteStatus {
	siteId: string;
	status: 'online' | 'offline' | 'partial';
	devices: DeviceStatus[];
	lastUpdate: string;
}

interface DeviceError {
	deviceId: number;
	errorType: string;
	message: string;
	timestamp: string;
	data?: Record<string, any>;
}

// WebSocket connection manager
const siteConnections = new Map<string, WebSocket>();
let redisClient: Redis;

// Site management functions
const handleSiteConnection = (site: Site, ws: WebSocket) => {
	siteConnections.set(site.id, ws);

	ws.on('message', async (message: string) => {
		try {
			const data = JSON.parse(message);
			await processSiteMessage(site.id, data);
		} catch (error) {
			console.error(`Error processing message from site ${site.id}:`, error);
		}
	});

	ws.on('close', () => {
		siteConnections.delete(site.id);
		updateSiteStatus(site.id, 'offline');
	});
};

// Message processing
const processSiteMessage = async (siteId: string, message: any) => {
	switch (message.type) {
		case 'reading':
			await processDeviceReading(siteId, message.data);
			break;
		case 'error':
			await processDeviceError(siteId, message.data);
			break;
		case 'status':
			await processDeviceStatuses(siteId, message.data);
			break;
	}
};

const processDeviceReading = async (siteId: string, reading: DeviceReading) => {
	try {
		await prisma.deviceReading.create({
			data: {
				siteId,
				deviceId: reading.deviceId,
				timestamp: new Date(reading.timestamp),
				hashRate: reading.data.hashRate,
				temperature: reading.data.temperature,
				fanSpeed: reading.data.fanSpeed,
				powerConsumption: reading.data.powerConsumption,
				energyReading: reading.data.energyReading,
				heatMeterReading: reading.data.heatMeterReading
			}
		});

		// Update real-time metrics for monitoring
		await updateMetrics(siteId, reading);
	} catch (error) {
		console.error(`Error processing reading for site ${siteId}:`, error);
	}
};

// Command handling
const sendCommand = async (siteId: string, command: Command) => {
	const ws = siteConnections.get(siteId);
	if (!ws) {
		throw new Error(`Site ${siteId} not connected`);
	}

	try {
		ws.send(JSON.stringify({
			type: 'command',
			data: command
		}));

		// Log command
		await prisma.commandLog.create({
			data: {
				siteId,
				deviceId: command.deviceId,
				commandType: command.type,
				parameters: command.parameters,
				timestamp: new Date()
			}
		});
	} catch (error) {
		console.error(`Error sending command to site ${siteId}:`, error);
		throw error;
	}
};

// Get site status
router.get('/sites/:siteId/status', authenticateClient, async (req, res) => {
	try {
		const status = await getSiteStatus(req.params.siteId);
		res.json(status);
	} catch (error) {
		res.status(500).json({ error: 'Failed to get site status' });
	}
});

// Send command to device
router.post('/sites/:siteId/devices/:deviceId/command', authenticateClient, async (req, res) => {
	try {
		const command: Command = {
			type: req.body.type,
			deviceId: parseInt(req.params.deviceId),
			siteId: req.params.siteId,
			parameters: req.body.parameters
		};

		await sendCommand(req.params.siteId, command);
		res.json({ success: true });
	} catch (error) {
		res.status(500).json({ error: 'Failed to send command' });
	}
});

// Get device metrics
router.get('/sites/:siteId/devices/:deviceId/metrics', authenticateClient, async (req, res) => {
	try {
		const metrics = await getDeviceMetrics(
			req.params.siteId,
			parseInt(req.params.deviceId),
			req.query.from as string,
			req.query.to as string
		);
		res.json(metrics);
	} catch (error) {
		res.status(500).json({ error: 'Failed to get device metrics' });
	}
});

// Analytics and monitoring
const updateMetrics = async (siteId: string, reading: DeviceReading) => {
	// Update Redis cache for real-time monitoring
	const redis = getRedisClient();
	const key = `site:${siteId}:device:${reading.deviceId}:metrics`;
	await redis.hset(key, {
		lastReading: JSON.stringify(reading),
		updatedAt: new Date().toISOString()
	});

	// Check thresholds and generate alerts if needed
	await checkThresholds(siteId, reading);
};

const checkThresholds = async (siteId: string, reading: DeviceReading) => {
	const thresholds = await getDeviceThresholds(reading.deviceId);

	if (reading.data.temperature && reading.data.temperature > thresholds.maxTemperature) {
		await generateAlert(siteId, {
			type: 'high_temperature',
			deviceId: reading.deviceId,
			value: reading.data.temperature
		});
	}

	// Add more threshold checks as needed
};

const generateAlert = async (siteId: string, alert: any) => {
	await prisma.alert.create({
		data: {
			siteId,
			deviceId: alert.deviceId,
			type: alert.type,
			value: alert.value,
			timestamp: new Date()
		}
	});

	// Notify relevant parties (email, SMS, etc.)
	await sendNotifications(siteId, 'sms', alert);
};

// Billing data collection
const collectBillingData = async (siteId: string, period: { start: Date; end: Date }) => {
	const energyReadings = await prisma.deviceReading.findMany({
		where: {
			siteId,
			timestamp: {
				gte: period.start,
				lte: period.end
			},
			energyReading: { not: null }
		}
	});

	// Calculate total energy consumption
	const totalEnergy = energyReadings.reduce((sum, reading) =>
		sum + (reading.energyReading || 0), 0);

	// Create billing record
	await prisma.billing.create({
		data: {
			siteId,
			period: period.start,
			energyConsumption: totalEnergy,
			// Add more billing data as needed
		}
	});
};


const getRedisClient = (): Redis => {
	if (!redisClient) {
		redisClient = new Redis({
			host: process.env.REDIS_HOST,
			port: parseInt(process.env.REDIS_PORT || '6379'),
			password: process.env.REDIS_PASSWORD,
			retryStrategy: (times) => Math.min(times * 50, 2000)
		});
	}
	return redisClient;
};


// Update site status in Redis and database
const updateSiteStatus = async (siteId: string, status: 'online' | 'offline' | 'partial') => {
	const redis = getRedisClient();
	const timestamp = new Date().toISOString();

	try {
		// Update Redis for real-time access
		await redis.hset(`site:${siteId}:status`, {
			status,
			lastUpdate: timestamp
		});

		// Update database for historical tracking
		await prisma.site.update({
			where: { id: siteId },
			data: {
				status: status,
				lastSeen: new Date(timestamp)
			}
		});

		// If site goes offline, generate alert
		if (status === 'offline') {
			await generateAlert(siteId, {
				type: 'site_offline',
				severity: 'high',
				message: `Site ${siteId} went offline`
			});
		}
	} catch (error) {
		console.error(`Error updating site status for ${siteId}:`, error);
		throw error;
	}
};

// Get current site status including all devices
const getSiteStatus = async (siteId: string): Promise<SiteStatus> => {
	const redis = getRedisClient();

	try {
		// Get site status from Redis
		const siteStatus = await redis.hgetall(`site:${siteId}:status`);

		// Get all device statuses for the site
		const deviceKeys = await redis.keys(`site:${siteId}:device:*:status`);
		const deviceStatuses: DeviceStatus[] = [];

		for (const key of deviceKeys) {
			const deviceData = await redis.hgetall(key);
			if (deviceData) {
				const deviceId = parseInt(key.split(':')[3]);
				deviceStatuses.push({
					deviceId,
					status: deviceData.status as 'online' | 'offline' | 'error',
					lastSeen: deviceData.lastSeen,
					errorMessage: deviceData.errorMessage
				});
			}
		}

		// Determine overall site status if not already set
		let status = siteStatus.status as 'online' | 'offline' | 'partial';
		if (!status) {
			const onlineDevices = deviceStatuses.filter(d => d.status === 'online').length;
			status = onlineDevices === 0 ? 'offline' :
				onlineDevices === deviceStatuses.length ? 'online' : 'partial';
		}

		return {
			siteId,
			status,
			devices: deviceStatuses,
			lastUpdate: siteStatus.lastUpdate || new Date().toISOString()
		};
	} catch (error) {
		console.error(`Error getting site status for ${siteId}:`, error);
		throw error;
	}
};

// Update status for multiple devices
const processDeviceStatuses = async (siteId: string, statuses: DeviceStatus[]) => {
	const redis = getRedisClient();
	const timestamp = new Date().toISOString();

	try {
		for (const status of statuses) {
			// Update Redis
			await redis.hset(
				`site:${siteId}:device:${status.deviceId}:status`,
				{
					status: status.status,
					lastSeen: timestamp,
					errorMessage: status.errorMessage || ''
				}
			);

			// If device status changed to error, generate alert
			if (status.status === 'error') {
				await generateAlert(siteId, {
					type: 'device_error',
					deviceId: status.deviceId,
					severity: 'medium',
					message: status.errorMessage
				});
			}
		}

		// Update overall site status
		const allStatuses = await Promise.all(
			statuses.map(s => redis.hgetall(`site:${siteId}:device:${s.deviceId}:status`))
		);

		const siteStatus = allStatuses.every(s => s.status === 'online') ? 'online' :
			allStatuses.every(s => s.status === 'offline') ? 'offline' : 'partial';

		await updateSiteStatus(siteId, siteStatus);
	} catch (error) {
		console.error(`Error processing device statuses for site ${siteId}:`, error);
		throw error;
	}
};

// Process device errors
const processDeviceError = async (siteId: string, error: DeviceError) => {
	try {
		// Store error in database
		await prisma.deviceError.create({
			data: {
				siteId,
				deviceId: error.deviceId,
				errorType: error.errorType,
				message: error.message,
				timestamp: new Date(error.timestamp),
				data: error.data || {}
			}
		});

		// Update device status in Redis
		const redis = getRedisClient();
		await redis.hset(
			`site:${siteId}:device:${error.deviceId}:status`,
			{
				status: 'error',
				lastError: error.timestamp,
				errorMessage: error.message
			}
		);

		// Generate alert based on error type
		const severity = getErrorSeverity(error.errorType);
		await generateAlert(siteId, {
			type: 'device_error',
			deviceId: error.deviceId,
			severity,
			message: error.message,
			data: error.data
		});
	} catch (error) {
		console.error(`Error processing device error for site ${siteId}:`, error);
		throw error;
	}
};

const getDeviceMetrics = async (
	siteId: string,
	deviceId: number,
	fromTime: string,
	toTime: string
) => {
	try {
		// Get recent metrics from Redis
		const redis = getRedisClient();
		const recentKey = `site:${siteId}:device:${deviceId}:metrics`;
		const recentMetrics = await redis.hgetall(recentKey);

		// Get historical metrics from database
		const historicalMetrics = await prisma.deviceReading.findMany({
			where: {
				siteId,
				deviceId,
				timestamp: {
					gte: new Date(fromTime),
					lte: new Date(toTime)
				}
			},
			orderBy: {
				timestamp: 'asc'
			}
		});

		return {
			current: recentMetrics,
			historical: historicalMetrics,
		};
	} catch (error) {
		console.error(`Error getting device metrics for ${siteId}/${deviceId}:`, error);
		throw error;
	}
};

const getDeviceThresholds = async (deviceId: number) => {
	const redis = getRedisClient();
	const thresholdsKey = `device:${deviceId}:thresholds`;

	try {
		const cachedThresholds = await redis.hgetall(thresholdsKey);
		if (Object.keys(cachedThresholds).length > 0) {
			return {
				maxTemperature: parseFloat(cachedThresholds.maxTemperature),
				minHashRate: parseFloat(cachedThresholds.minHashRate),
				maxPowerConsumption: parseFloat(cachedThresholds.maxPowerConsumption)
			};
		}

		const deviceConfig = await prisma.deviceConfiguration.findUnique({
			where: { deviceId }
		});

		if (!deviceConfig) {
			return getDefaultThresholds(deviceId);
		}

		await redis.hmset(thresholdsKey, {
			maxTemperature: deviceConfig.maxTemperature.toString(),
			minHashRate: deviceConfig.minHashRate.toString(),
			maxPowerConsumption: deviceConfig.maxPowerConsumption.toString()
		});
		await redis.expire(thresholdsKey, 3600); // Cache for 1 hour

		return {
			maxTemperature: deviceConfig.maxTemperature,
			minHashRate: deviceConfig.minHashRate,
			maxPowerConsumption: deviceConfig.maxPowerConsumption
		};
	} catch (error) {
		console.error(`Error getting device thresholds for ${deviceId}:`, error);
		return getDefaultThresholds(deviceId);
	}
};

const sendNotifications = async (
	siteId: string,
	types: 'email' | 'sms' | 'slack'[],
	alert: any) => {

	try {
		// Log notification
		for (const type of types) {
			await prisma.notificationLog.create({
				data: {
					siteId,
					type,
					alert
				}
			});
		}
	} catch (error) {
		console.error(`Error sending notification:`, error);
		throw error;
	}
}

const getDefaultThresholds = (deviceId: number) => ({
	maxTemperature: 85,
	minHashRate: 50,
	maxPowerConsumption: 3500
});

const getErrorSeverity = (errorType: string): 'low' | 'medium' | 'high' => {
	const severityMap: Record<string, 'low' | 'medium' | 'high'> = {
		hardware_failure: 'high',
		connection_lost: 'medium',
		performance_degraded: 'low'
	};
	return severityMap[errorType] || 'medium';
};

const average = (numbers: number[]) =>
	numbers.reduce((a, b) => a + b, 0) / numbers.length;


export {
	handleSiteConnection,
	sendCommand,
	updateSiteStatus,
	getSiteStatus,
	processDeviceStatuses,
	processDeviceError,
	getDeviceMetrics,
	getRedisClient,
	getDeviceThresholds,
	sendNotifications,
	router as deviceApiRouter
};
