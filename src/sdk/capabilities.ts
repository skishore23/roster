/** Stable function-catalog and data-reference capability surface. */
export {
  ROSTER_CAPABILITY_CATALOG_VERSION,
  RosterFunctionDirectory,
} from "../engine/functions/function-directory.js";
export type {
  RosterFunctionAccess,
  RosterCapabilityCatalogDescription,
  RosterCapabilityCatalogEntry,
  RosterCapabilityCatalogProjection,
  RosterCapabilityCatalogProvider,
  RosterCapabilityCatalogSearchResult,
  RosterFunctionDescriptor,
  RosterFunctionDirectoryOptions,
  RosterFunctionEffect,
  RosterFunctionInvocationAction,
  RosterFunctionInvocationResult,
  RosterFunctionProvider,
  RosterFunctionProviderControl,
  RosterFunctionSchema,
  RosterFunctionTool,
} from "../engine/functions/function-directory.js";

export {
  createArtifactDataReferenceLocator,
  createObjectDataReferenceLocator,
  DurableBlobDataReferenceStore,
  InMemoryDataReferenceStore,
} from "../engine/dataflow/data-reference-store.js";
export type {
  DataReferenceStore,
  DataReferenceStoreDurability,
  DataReferenceStoreLimits,
  DataReferenceWrite,
  DurableBlobDataReferenceStoreOptions,
  DurableDataReferenceLocation,
  DurableDataReferenceLocator,
  DurableDataReferenceLocatorInput,
  ImmutableDataReferenceBlobBackend,
} from "../engine/dataflow/data-reference-store.js";
