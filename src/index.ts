#!/usr/bin/env node

import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { authoritexAppHtml } from "./app.js";
import {
  AuthoritexClient,
  MemoryAuthoritexCache,
  type AuthorityRecord,
  type FetchOptions,
  type SearchResult,
  AuthoritexError,
  AuthorityServiceError,
  BadResponseError,
  HttpStatusError,
  NetworkError,
  NotFoundError,
  UnknownAuthorityError
} from "@nulib/authoritex-js";

type ToolErrorPayload = {
  name: string;
  message: string;
  details?: Record<string, unknown>;
};

type ToolName =
  | "fetch"
  | "search"
  | "open_authoritex"
  | "cache_delete_fetch"
  | "cache_delete_search"
  | "cache_clear";

const AUTHORITEX_APP_URI = "ui://authoritex/search.html";
const DEFAULT_CACHE_MAX_ENTRIES = 1000;
const DEFAULT_SEARCH_MAX_RESULTS = 10;

const client = new AuthoritexClient({
  geonamesUsername: process.env.GEONAMES_USERNAME,
  cache: {
    store: new MemoryAuthoritexCache({
      maxEntries: integerFromEnv("AUTHORITEX_CACHE_MAX_ENTRIES", DEFAULT_CACHE_MAX_ENTRIES)
    })
  }
});

const authorityList = client.authorities().map(({ code, description }) => ({
  code,
  description,
  label: authorityLabel(code, description)
}));

type OpenAuthoritexInput = {
  authorityCode?: string;
  query?: string;
  maxResults?: number;
};

const server = new McpServer({
  name: "authoritex",
  version: "0.1.0"
});

server.registerResource(
  "authorities",
  "authoritex://authorities",
  {
    title: "Authoritex Authorities",
    description: "Available authority codes and descriptions for Authoritex search operations.",
    mimeType: "application/json"
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify({ authorities: authorityList }, null, 2)
      }
    ]
  })
);

server.registerTool(
  "fetch",
  {
    title: "Fetch",
    description: "Fetch a normalized authority record by URI or ID.",
    annotations: {
      readOnlyHint: true
    },
    inputSchema: {
      id: z.string().min(1).describe("Authority URI or ID to fetch."),
      redirect: z
        .boolean()
        .optional()
        .describe("Follow replacement links for obsolete authority IDs.")
    }
  },
  async ({ id, redirect }) => {
    try {
      const options: FetchOptions = {};
      if (typeof redirect === "boolean") {
        options.redirect = redirect;
      }

      const record = await client.fetch(id, options);
      return successResult({ record });
    } catch (error) {
      return errorResult("fetch", error);
    }
  }
);

server.registerTool(
  "search",
  {
    title: "Search",
    description: "Search an authority source for candidate terms.",
    annotations: {
      readOnlyHint: true
    },
    inputSchema: {
      authorityCode: z
        .string()
        .min(1)
        .describe("Authority code such as lcnaf, lcsh, fast, geonames, or aat."),
      query: z.string().min(1).describe("Search query string."),
      maxResults: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe("Optional result limit between 1 and 100.")
    }
  },
  async ({ authorityCode, query, maxResults }) => {
    try {
      const results = await client.search(authorityCode, query, maxResults);
      return successResult({ results });
    } catch (error) {
      return errorResult("search", error);
    }
  }
);

registerAppTool(
  server,
  "open_authoritex",
  {
    title: "Open Authoritex",
    description:
      "Open an interactive Authoritex search and fetch interface. Optionally prefill and run a search by passing authorityCode, query, and maxResults.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true
    },
    inputSchema: {
      authorityCode: z
        .string()
        .min(1)
        .optional()
        .describe("Optional authority code to preselect, such as lcsh, lcnaf, fast, geonames, or aat."),
      query: z.string().min(1).optional().describe("Optional search query to prefill and run."),
      maxResults: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe("Optional result limit between 1 and 100.")
    },
    _meta: {
      ui: {
        resourceUri: AUTHORITEX_APP_URI,
        visibility: ["model"]
      }
    }
  },
  async ({ authorityCode, query, maxResults }: OpenAuthoritexInput) => {
    const initialSearch = initialSearchPayload({ authorityCode, query, maxResults });
    if (!initialSearch.query) {
      return successResult({ authorities: authorityList, initialSearch });
    }

    try {
      const results = await client.search(
        initialSearch.authorityCode,
        initialSearch.query,
        initialSearch.maxResults
      );
      return successResult({ authorities: authorityList, initialSearch, results });
    } catch (error) {
      return errorResult("open_authoritex", error);
    }
  }
);

registerAppResource(
  server,
  "Authoritex App",
  AUTHORITEX_APP_URI,
  {
    title: "Authoritex App",
    description: "Interactive search and fetch UI for Authoritex authority records.",
    _meta: {
      ui: {
        prefersBorder: true
      }
    }
  },
  async () => ({
    contents: [
      {
        uri: AUTHORITEX_APP_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: authoritexAppHtml(),
        _meta: {
          ui: {
            prefersBorder: true
          }
        }
      }
    ]
  })
);

server.registerTool(
  "cache_delete_fetch",
  {
    title: "Delete Cached Fetch",
    description:
      "Delete currently cached fetch results for an authority URI or ID. Cached entries may also expire automatically based on the configured TTL.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true
    },
    inputSchema: {
      id: z.string().min(1).describe("Authority URI or ID whose cached fetch result should be deleted."),
      redirect: z
        .boolean()
        .optional()
        .describe("Delete only the redirected or non-redirected cached fetch result. Omit to delete both.")
    }
  },
  async ({ id, redirect }) => {
    try {
      const options: FetchOptions = {};
      if (typeof redirect === "boolean") {
        options.redirect = redirect;
      }

      const deleted = await client.deleteCachedFetch(id, options);
      if (!deleted) {
        return cacheUnavailableResult("cache_delete_fetch", "delete");
      }

      return successResult({ deleted: true });
    } catch (error) {
      return errorResult("cache_delete_fetch", error);
    }
  }
);

server.registerTool(
  "cache_delete_search",
  {
    title: "Delete Cached Search",
    description:
      "Delete currently cached search results for an authority, query, and optional result limit. Cached entries may also expire automatically based on the configured TTL.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true
    },
    inputSchema: {
      authorityCode: z
        .string()
        .min(1)
        .describe("Authority code such as lcnaf, lcsh, fast, geonames, or aat."),
      query: z.string().min(1).describe("Search query string whose cached result should be deleted."),
      maxResults: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe("Optional result limit between 1 and 100. Must match the cached search call.")
    }
  },
  async ({ authorityCode, query, maxResults }) => {
    try {
      const deleted = await client.deleteCachedSearch(authorityCode, query, maxResults);
      if (!deleted) {
        return cacheUnavailableResult("cache_delete_search", "delete");
      }

      return successResult({ deleted: true });
    } catch (error) {
      return errorResult("cache_delete_search", error);
    }
  }
);

server.registerTool(
  "cache_clear",
  {
    title: "Clear Cache",
    description:
      "Clear all currently cached Authoritex fetch and search results. Cached entries may also expire automatically based on the configured TTL.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true
    },
    inputSchema: {}
  },
  async () => {
    try {
      const cleared = await client.clearCache();
      if (!cleared) {
        return cacheUnavailableResult("cache_clear", "clear");
      }

      return successResult({ cleared: true });
    } catch (error) {
      return errorResult("cache_clear", error);
    }
  }
);

function successResult<T extends Record<string, unknown>>(payload: T): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: T;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ],
    structuredContent: payload
  };
}

function authorityLabel(code: string, description?: string): string {
  return description ? `${description} (${code})` : code;
}

function initialSearchPayload({ authorityCode, query, maxResults }: OpenAuthoritexInput): {
  authorityCode: string;
  query: string;
  maxResults: number;
} {
  const normalizedCode = authorityCode?.trim() || "fast";
  const knownAuthority = authorityList.find(({ code }) => code === normalizedCode);

  return {
    authorityCode: knownAuthority?.code ?? "fast",
    query: query?.trim() ?? "",
    maxResults: maxResults ?? DEFAULT_SEARCH_MAX_RESULTS
  };
}

function errorResult(
  toolName: ToolName,
  error: unknown
): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { error: ToolErrorPayload; tool: string };
} {
  const normalized = normalizeError(error);

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            tool: toolName,
            error: normalized
          },
          null,
          2
        )
      }
    ],
    structuredContent: {
      tool: toolName,
      error: normalized
    }
  };
}

function cacheUnavailableResult(
  toolName: ToolName,
  operation: "delete" | "clear"
): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { error: ToolErrorPayload; tool: string };
} {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            tool: toolName,
            error: {
              name: "CacheUnavailableError",
              message: `Cache ${operation} is unavailable for this Authoritex MCP server.`,
              details: {
                cacheEnabled: client.cacheEnabled(),
                deleteSupported: client.cacheDeletionSupported(),
                clearSupported: client.cacheClearSupported()
              }
            }
          },
          null,
          2
        )
      }
    ],
    structuredContent: {
      tool: toolName,
      error: {
        name: "CacheUnavailableError",
        message: `Cache ${operation} is unavailable for this Authoritex MCP server.`,
        details: {
          cacheEnabled: client.cacheEnabled(),
          deleteSupported: client.cacheDeletionSupported(),
          clearSupported: client.cacheClearSupported()
        }
      }
    }
  };
}

function normalizeError(error: unknown): ToolErrorPayload {
  if (error instanceof UnknownAuthorityError) {
    return {
      name: error.name,
      message: error.message,
      details: {
        authorityCode: error.authorityCode,
        id: error.id
      }
    };
  }

  if (error instanceof NotFoundError) {
    return {
      name: error.name,
      message: error.message,
      details: {
        status: error.status
      }
    };
  }

  if (error instanceof HttpStatusError) {
    return {
      name: error.name,
      message: error.message,
      details: {
        status: error.status,
        body: error.body
      }
    };
  }

  if (error instanceof BadResponseError) {
    return {
      name: error.name,
      message: error.message
    };
  }

  if (error instanceof AuthorityServiceError || error instanceof NetworkError) {
    return {
      name: error.name,
      message: error.message,
      details: extractCauseDetails(error)
    };
  }

  if (error instanceof AuthoritexError) {
    return {
      name: error.name,
      message: error.message
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message
    };
  }

  return {
    name: "UnknownError",
    message: "Unknown error"
  };
}

function extractCauseDetails(error: unknown): Record<string, unknown> | undefined {
  if (!isObjectLike(error)) {
    return undefined;
  }

  const details: Record<string, unknown> = {};
  const name = error.name;
  const code = error.code;
  const message = error.message;
  const syscall = error.syscall;

  if (typeof name === "string") {
    details.name = name;
  }
  if (typeof code === "string") {
    details.code = code;
  }
  if (typeof message === "string") {
    details.message = message;
  }
  if (typeof syscall === "string") {
    details.syscall = syscall;
  }

  const cause = error.cause;
  if (cause && cause !== error) {
    const causeDetails = extractCauseDetails(cause);
    if (causeDetails) {
      details.cause = causeDetails;
    }
  }

  return Object.keys(details).length > 0 ? details : undefined;
}

function isObjectLike(error: unknown): error is {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  syscall?: unknown;
  cause?: unknown;
} {
  return typeof error === "object" && error !== null;
}

function integerFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  const details = normalizeError(error);
  process.stderr.write(`${JSON.stringify({ error: details }, null, 2)}\n`);
  process.exit(1);
});
