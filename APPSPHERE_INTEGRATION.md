# AppSphere / Besiter Integration

This project now treats cabinet hardware as a provider:

- `heycharge` remains the default provider and keeps the current live stations working.
- `appsphere` is available as a separate provider lane, but it must be connected through a tested bridge before any customer station is enabled.

## Why AppSphere Needs A Bridge

The AppSphere/Besiter cabinet package and API document show that real cabinet control is not the same as HeyCharge HTTP:

- query cabinet: publish `{"cmd":"check_all"}` or `{"cmd":"check"}`
- normal rental eject: publish `{"cmd":"popup_sn","data":"<powerbank SN>"}`
- maintenance-only eject by slot: publish `{"cmd":"popup","data":"<slot>","io":"<deck address>"}`
- eject result: cabinet reports command `0x31`
- return result: cabinet reports command `0x40`

Vercel is not a good place for a permanent MQTT listener, so the safe production shape is:

1. Danab payment app charges customer only after a rentable battery is selected.
2. Danab payment app calls `APPSPHERE_BRIDGE_URL`.
3. Bridge sends AppSphere/Besiter MQTT command `popup_sn`.
4. Bridge waits for command `0x31` and refreshes latest slot state.
5. Payment app verifies the selected battery is no longer present.
6. Rental record is created only after verified eject.

## Payment App Environment

The bridge implementation is in:

```text
C:\Users\Abdifth\Documents\New project 3\appsphere-cabinet-lite-system\cabinet-lite-system
```

Set these only after the bridge is deployed and tested:

```env
APPSPHERE_BRIDGE_URL=https://your-bridge.example.com
APPSPHERE_BRIDGE_SECRET=use-a-long-random-secret

STATION_20_PROVIDER=appsphere
STATION_20_CABINET_SN=your-cabinet-sn
```

The current migrated Danab AppSphere stations are built into the payment app:

| Customer URL | Cabinet SN |
| --- | --- |
| `https://station20.danab.site` | Elite Hotel / `49000620` |
| `https://station21.danab.site` | Karmel / `49000621` |
| `https://station22.danab.site` | Crepe One / `49000622` |
| `https://station27.danab.site` | `49000627` |
| `https://station34.danab.site` | `49000634` |

For fresh AppSphere battery state, the payment app sends a bridge refresh before reading `/batteries` by default. Disable only for debugging with `APPSPHERE_REFRESH_BEFORE_READ=false`.

Existing HeyCharge stations need no provider value because `heycharge` is the default:

```env
STATION_58_IMEI=WSEP161721195358
```

## Bridge Contract Expected By PaymentSystem

The payment app expects:

```http
GET /api/cabinets/:cabinetSn/batteries
```

Response can contain `batteries` or `slots`. Each slot should include:

- powerbank SN: `terminalId`, `powerBankSn`, `singleSN`, `sn`, or `battery_id`
- slot: `slot`, `slotId`, `slotIndex`, or `slot_id`
- battery level: `level`, `remainingPower`, `electricityQuantity`, or `battery_capacity`
- health/status: `status`, `statusHex`, `statusText`, `slotStatus`, or compatible fields

```http
POST /api/cabinets/:cabinetSn/eject
Content-Type: application/json

{
  "batteryId": "123456",
  "slotId": "5",
  "terminalId": "123456"
}
```

The bridge should use `popup_sn` for real rental ejects. Slot eject should stay a maintenance/admin action.

## Values Still Needed From AppSphere

- cabinet SN for each new machine
- product key / MQTT topic token if different from cabinet SN
- MQTT broker host, port, username, and password, or a supported AppSphere cloud API for command issue
- one safe test cabinet online in the AppSphere dashboard
- which Danab station number/domain should point at each new cabinet
