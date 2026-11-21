import { localPref, parseBool } from "./local-pref";

/**
 * Whether the 3D viewers draw the realistic look (a room, a sun, shadows) instead of the flat one. The viewer's
 * own taste, so per browser and the same in every viewer. A field painted on the model (thickness, deviation) is
 * always drawn flat: its colours are measurements.
 */
export const realisticShading = localPref<boolean>("drawer.viewer.realistic", false, parseBool);
