declare const __DOLU_FIVEM_MCP_BUILD_ID__: string;

export const BUILD_ID =
  typeof __DOLU_FIVEM_MCP_BUILD_ID__ === "string"
    ? __DOLU_FIVEM_MCP_BUILD_ID__
    : "development";
