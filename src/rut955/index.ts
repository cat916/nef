import ModbusRTU from 'modbus-serial';
import { WebSocket } from 'ws';
import { EventEmitter } from 'events';

// H60S Control Board Register Mappings
const H60S_REGISTERS = {
	// Status registers
	HASH_RATE: 1000,         // Hash rate in TH/s (2 registers)
	TEMPERATURE: 1002,       // Temperature in Celsius
	FAN_SPEED: 1003,        // Fan speed in RPM
	POWER_CONSUMPTION: 1004, // Power consumption in watts
	ERROR_STATUS: 1005,     // Error status bits

	// Control registers
	CONTROL_MODE: 2000,     // Operation mode
	FREQUENCY_SET: 2001,    // Frequency setting
	FAN_SPEED_SET: 2002,    // Fan speed setting
	POWER_LIMIT: 2003,      // Power limit setting
	RESTART_CMD: 2004,      // Restart command
	SHUTDOWN_CMD: 2005      // Shutdown command
} as const;

// Types for local device configuration
interface DeviceConfig {
	controlBoards: ControlBoardConfig[];
	energyMeters: ModbusDeviceConfig[];
	heatMeters: ModbusDeviceConfig[];
}

interface ControlBoardConfig {
	id: number;
	ip: string;
	port: number;
	minerCount: number;
}

interface ModbusDeviceConfig {
	id: number;
	ip: string;
	port: number;
}

// Local state management
interface LocalState {
	lastReadings: Map<number, any>;
	connectionStatus: Map<number, boolean>;
	deviceErrors: Map<number, string[]>;
}

// Websocket message types
interface WSMessage {
	type: 'command' | 'reading' | 'error';
	deviceId: number;
	data: any;
}

// Initialize local state
const state: LocalState = {
	lastReadings: new Map(),
	connectionStatus: new Map(),
	deviceErrors: new Map()
};

// Create event emitter for local events
const events = new EventEmitter();

// Load local configuration
const config: DeviceConfig = {
	controlBoards: [
		{ id: 1, ip: '192.168.1.101', port: 502, minerCount: 4 },
		{ id: 2, ip: '192.168.1.102', port: 502, minerCount: 4 }
	],
	energyMeters: [
		{ id: 10, ip: '192.168.1.201', port: 502 }
	],
	heatMeters: [
		{ id: 20, ip: '192.168.1.301', port: 502 }
	]
};

// MODBUS communication handler
const createModbusClient = async (deviceConfig: ControlBoardConfig | ModbusDeviceConfig) => {
	const client = new ModbusRTU();
	try {
		await client.connectTCP(deviceConfig.ip, { port: deviceConfig.port });
		client.setID(deviceConfig.id);
		state.connectionStatus.set(deviceConfig.id, true);
		return client;
	} catch (error) {
		state.connectionStatus.set(deviceConfig.id, false);
		state.deviceErrors.set(deviceConfig.id, [(error as Error).message]);
		throw error;
	}
};

// Data collection functions
const collectControlBoardData = async (board: ControlBoardConfig, callback: Function) => {
	try {
		const client = await createModbusClient(board);

		// Read miner statistics
		const hashRate = await client.readHoldingRegisters(H60S_REGISTERS.HASH_RATE, 2);
		const temperature = await client.readHoldingRegisters(H60S_REGISTERS.TEMPERATURE, 1);
		const fanSpeed = await client.readHoldingRegisters(H60S_REGISTERS.FAN_SPEED, 1);

		const reading = {
			deviceId: board.id,
			timestamp: new Date().toISOString(),
			data: {
				hashRate: hashRate.data,
				temperature: temperature.data,
				fanSpeed: fanSpeed.data
			}
		};

		state.lastReadings.set(board.id, reading);
		events.emit('reading', reading);

		client.close(callback);
	} catch (error) {
		console.error(`Error collecting data from control board ${board.id}:`, error);
		events.emit('error', { deviceId: board.id, error });
	}
};

// Command handling
const handleCommand = async (command: WSMessage) => {
	const { deviceId, data } = command;
	const device = [...config.controlBoards, ...config.energyMeters, ...config.heatMeters]
		.find(d => d.id === deviceId);

	if (!device) {
		throw new Error(`Unknown device ID: ${deviceId}`);
	}

	const client = await createModbusClient(device);

	try {
		switch (data.action) {
			case 'restart':
				await client.writeRegister(H60S_REGISTERS.RESTART_CMD, 1);
				break;
			case 'updateConfig':
				if (data.frequency) {
					await client.writeRegister(H60S_REGISTERS.FREQUENCY_SET, data.frequency);
				}
				if (data.fanSpeed) {
					await client.writeRegister(H60S_REGISTERS.FAN_SPEED_SET, data.fanSpeed);
				}
				break;
			case 'shutdown':
				await client.writeRegister(H60S_REGISTERS.SHUTDOWN_CMD, 1);
				break;
			default:
				throw new Error(`Unknown command: ${data.action}`);
		}
		client.close(() => console.log(`Command executed for device ${deviceId}:`, data));
		events.emit('commandComplete', { deviceId, command: data });
	} catch (error) {
		console.error(`Error executing command for device ${deviceId}:`, error);
		events.emit('commandError', { deviceId, command: data, error });
	}
};

// Cloud communication
const setupCloudConnection = () => {
	const ws = new WebSocket('wss://your-cloud-server.com');

	ws.on('open', () => {
		console.log('Connected to cloud server');
		// Send initial state
		ws.send(JSON.stringify({
			type: 'status',
			data: {
				deviceStates: Array.from(state.connectionStatus.entries()),
				errors: Array.from(state.deviceErrors.entries())
			}
		}));
	});

	ws.on('message', async (data: string) => {
		try {
			const message: WSMessage = JSON.parse(data);
			if (message.type === 'command') {
				await handleCommand(message);
			}
		} catch (error) {
			console.error('Error handling websocket message:', error);
		}
	});

	// Forward local events to cloud
	events.on('reading', (reading) => {
		ws.send(JSON.stringify({
			type: 'reading',
			data: reading
		}));
	});

	events.on('error', (error) => {
		ws.send(JSON.stringify({
			type: 'error',
			data: error
		}));
	});

	// Handle disconnection
	ws.on('close', () => {
		console.log('Disconnected from cloud server, attempting to reconnect...');
		setTimeout(setupCloudConnection, 5000);
	});

	ws.on('error', (error) => {
		console.error('WebSocket error:', error);
	});
};

// Start data collection
const startDataCollection = () => {
	// Collect data from control boards every 30 seconds
	setInterval(() => {
		config.controlBoards.forEach(board => {
			collectControlBoardData(board, console.log).catch(console.error);
		});
	}, 30000);

	// Additional collection intervals for other devices can be added here
};

// Main application
const main = async () => {
	try {
		// Initialize cloud connection
		setupCloudConnection();

		// Start data collection
		startDataCollection();

		console.log('RUT955 management application started');
	} catch (error) {
		console.error('Error starting application:', error);
		process.exit(1);
	}
};

// Handle process termination
process.on('SIGTERM', () => {
	console.log('Shutting down...');
	// Cleanup code here
	process.exit(0);
});

// Start the application
main().catch(console.error);
