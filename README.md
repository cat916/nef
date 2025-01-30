```mermaid
flowchart TB
    subgraph CloudSystem["Cloud Management System"]
        API["API Gateway"]
        
        subgraph ManagementServices["Management Services"]
            ConfigMS["Configuration Management"]
            MonitorMS["Monitoring Service"]
            ControlMS["Control Service"]
            AlertMS["Alert Service"]
            AutomationMS["Automation Service"]
        end
        
        subgraph DataAnalytics["Data Analytics"]
            PerfAnalysis["Performance Analysis"]
            PredMaint["Predictive Maintenance"]
            OptimEngine["Optimization Engine"]
        end
    end
    
    subgraph Site["Mining Site"]
        Router["Teltonika RUT955"]
        
        subgraph MiningUnit["Mining Unit"]
            ControlBoard["H60S Control Board\n(MODBUS Slave)"]
            subgraph Miners["ASIC Miners"]
                Miner1["Miner 1"]
                Miner2["Miner 2"]
                MinerN["Miner N"]
            end
        end
        
        subgraph Sensors["Site Sensors"]
            EnergyMeter["Energy Meter\n(MODBUS Slave)"]
            TempSensor["Temperature Sensor\n(MODBUS Slave)"]
            HeatMeter["Heat Meter\n(MODBUS Slave)"]
        end
    end
    
    CloudSystem -- "Commands via VPN" --> Router
    Router -- "Status Updates via VPN" --> CloudSystem
    Router -- "MODBUS Master" --> ControlBoard
    ControlBoard -- "Direct Control" --> Miners
    Router -- "MODBUS Master" --> Sensors
