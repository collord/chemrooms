/**
 * Cesium integration for chemrooms: viewer slice, panel, entity layer,
 * clock sync and SQL-to-entity hooks.
 *
 * History. This began as a proposed `@sqlrooms/cesium` package
 * (sqlrooms/sqlrooms#530). The maintainer preferred an example over a
 * monorepo package, so the code was folded into
 * `examples/cesium-quakes-standalone/src/cesium` on that PR, and this folder
 * is a copy of that reviewed version. It contains the April 2026 review
 * fixes (clock feedback-loop guard, NaN/null guards on entity descriptors)
 * and the chemrooms-driven clipping-plane and zoom-height work that
 * previously lived only on the collord/sqlrooms fork. Chemrooms no longer
 * depends on that fork: every other @sqlrooms package comes from npm.
 *
 * SQLRooms' own architecture doc describes custom slices composed into the
 * room store as the intended extension path, which is what this is. If a
 * second consumer appears, publish this folder as a package of its own.
 */

// ============================================================================
// Components
// ============================================================================

export {CesiumPanel} from './components/CesiumPanel';
export {CesiumViewerWrapper} from './components/CesiumViewerWrapper';
export {CesiumEntityLayer} from './components/CesiumEntityLayer';
export type {CesiumEntityLayerProps} from './components/CesiumEntityLayer';
export {CesiumToolbar} from './components/CesiumToolbar';
export type {CesiumToolbarProps} from './components/CesiumToolbar';
export {CesiumClock} from './components/CesiumClock';
export type {CesiumClockProps} from './components/CesiumClock';

// ============================================================================
// State Management
// ============================================================================

export {createCesiumSlice, useStoreWithCesium} from './cesium-slice';
export type {RoomStateWithCesium} from './cesium-slice';
export type {CesiumSliceState, CesiumRuntimeState} from './cesium-types';

// ============================================================================
// Configuration
// ============================================================================

export {
  CesiumSliceConfig,
  CameraPosition,
  ClockConfig,
  ColumnMapping,
  CesiumLayerConfig,
  createDefaultCesiumConfig,
} from './cesium-config';

// Export types inferred from Zod schemas
export type {
  CesiumSliceConfig as CesiumSliceConfigType,
  CameraPosition as CameraPositionType,
  ClockConfig as ClockConfigType,
  ColumnMapping as ColumnMappingType,
  CesiumLayerConfig as CesiumLayerConfigType,
} from './cesium-config';

// ============================================================================
// Hooks
// ============================================================================

export {useCesiumViewer} from './hooks/useCesiumViewer';
export {useSqlToCesiumEntities} from './hooks/useSqlToCesiumEntities';
export type {CesiumEntityDescriptor} from './hooks/useSqlToCesiumEntities';
export {useClockSync} from './hooks/useClockSync';

// ============================================================================
// Re-exports from Cesium (for convenience)
// ============================================================================

export type {Viewer as CesiumViewer, Entity} from 'cesium';
