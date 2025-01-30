import { PrismaClient } from '@prisma/client';
import express from 'express';
import { authenticateClient } from './auth';
import { WebSocket } from 'ws';

const prisma = new PrismaClient();
const router = express.Router();

// Types and interfaces
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

// WebSocket connection manager
const siteConnections = new Map<string, WebSocket>();

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
			await updateDeviceStatuses(siteId, message.data);
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
	await sendNotifications(siteId, alert);
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

export {
	handleSiteConnection,
	sendCommand,
	router as deviceApiRouter
};
