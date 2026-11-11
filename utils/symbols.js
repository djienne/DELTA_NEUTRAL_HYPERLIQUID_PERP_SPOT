// PERP <-> SPOT symbol map (config.json symbolMapping.perpToSpot, e.g. BTC -> UBTC); unmapped symbols map to themselves.
// Read by this file's URL, so it works from any working directory.
import fs from 'fs';

const perpToSpotMap = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8')).symbolMapping?.perpToSpot ?? {};
const spotToPerpMap = Object.fromEntries(Object.entries(perpToSpotMap).map(([perp, spot]) => [spot, perp]));
export const perpToSpot = perp => perpToSpotMap[perp] ?? perp;
export const spotToPerp = spot => spotToPerpMap[spot] ?? spot;
