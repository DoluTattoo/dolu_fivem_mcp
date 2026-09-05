import { z } from "zod";

const configSchema = z.object({
  port: z.coerce.number().int().min(1024).max(65535).default(3210),
  ace: z.string().min(1).default("dolu_fivem_mcp.use"),
  cdpPort: z.coerce.number().int().min(1024).max(65535).default(13172),
  cdpPlayer: z.coerce.number().int().nonnegative().default(0),
  maxActive: z.coerce.number().int().min(1).max(32).default(8),
});
export type Config = z.infer<typeof configSchema>;
export function readConfig(
  get: (key: string, fallback: string) => string,
): Config {
  const config = configSchema.parse({
    port: get("dolu_fivem_mcp_port", "3210"),
    ace: get("dolu_fivem_mcp_ace", "dolu_fivem_mcp.use"),
    cdpPort: get("dolu_fivem_mcp_cdp_port", "13172"),
    cdpPlayer: get("dolu_fivem_mcp_cdp_player", "0"),
    maxActive: get("dolu_fivem_mcp_max_active", "8"),
  });
  if (config.port === config.cdpPort)
    throw new Error("MCP and CEF DevTools must use different ports");
  return config;
}
