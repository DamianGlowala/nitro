import { resolve, join } from 'pathe'
import { loadConfig } from 'c12'
import { klona } from 'klona/full'
import { camelCase } from 'scule'
import { defu } from 'defu'
import { resolveModuleExportNames, resolvePath as resovleModule } from 'mlly'
// import escapeRE from 'escape-string-regexp'
import { withLeadingSlash, withoutTrailingSlash, withTrailingSlash } from 'ufo'
import { isTest, isDebug } from 'std-env'
import { findWorkspaceDir } from 'pkg-types'
import { resolvePath, detectTarget } from './utils'
import type { NitroConfig, NitroOptions, NitroRouteConfig, NitroRouteOptions } from './types'
import { runtimeDir, pkgDir } from './dirs'
import * as _PRESETS from './presets'
import { nitroImports } from './imports'

const NitroDefaults: NitroConfig = {
  // General
  debug: isDebug,
  logLevel: isTest ? 1 : 3,
  runtimeConfig: { app: {}, nitro: {} },

  // Dirs
  scanDirs: [],
  buildDir: '.nitro',
  output: {
    dir: '{{ rootDir }}/.output',
    serverDir: '{{ output.dir }}/server',
    publicDir: '{{ output.dir }}/public'
  },

  // Featueres
  experimental: {},
  storage: {},
  devStorage: {},
  bundledStorage: [],
  publicAssets: [],
  serverAssets: [],
  plugins: [],
  imports: {
    exclude: [/[\\/]node_modules[\\/]/, /[\\/]\.git[\\/]/],
    presets: nitroImports
  },
  virtual: {},
  compressPublicAssets: false,

  // Dev
  dev: false,
  devServer: { watch: [] },
  watchOptions: { ignoreInitial: true },

  // Routing
  baseURL: process.env.NITRO_APP_BASE_URL || '/',
  handlers: [],
  devHandlers: [],
  errorHandler: '#internal/nitro/error',
  routes: {},
  prerender: {
    crawlLinks: false,
    ignore: [],
    routes: []
  },

  // Rollup
  alias: {
    '#internal/nitro': runtimeDir
  },
  unenv: {},
  analyze: false,
  moduleSideEffects: [
    'unenv/runtime/polyfill/',
    'node-fetch-native/polyfill',
    'node-fetch-native/dist/polyfill'
  ],
  replace: {},
  node: true,
  sourceMap: true,

  // Advanced
  typescript: {
    generateTsConfig: true,
    internalPaths: false
  },
  nodeModulesDirs: [],
  hooks: {},
  commands: {}
}

export async function loadOptions (configOverrides: NitroConfig = {}): Promise<NitroOptions> {
  // Preset
  let presetOverride = configOverrides.preset || process.env.NITRO_PRESET
  const defaultPreset = detectTarget() || 'node-server'
  if (configOverrides.dev) {
    presetOverride = 'nitro-dev'
  }

  // Load configuration and preset
  configOverrides = klona(configOverrides)
  const { config, layers } = await loadConfig({
    name: 'nitro',
    cwd: configOverrides.rootDir,
    dotenv: configOverrides.dev,
    extend: { extendKey: ['extends', 'preset'] },
    overrides: {
      ...configOverrides,
      preset: presetOverride
    },
    defaultConfig: {
      preset: defaultPreset
    },
    defaults: NitroDefaults,
    resolve (id: string) {
      const presets = _PRESETS as any as Map<String, NitroConfig>
      let matchedPreset = presets[camelCase(id)] || presets[id]
      if (!matchedPreset) {
        return null
      }
      if (typeof matchedPreset === 'function') {
        matchedPreset = matchedPreset()
      }
      return {
        config: matchedPreset
      }
    }
  })
  const options = klona(config) as NitroOptions
  options._config = configOverrides

  options.preset = presetOverride || layers.find(l => l.config.preset)?.config.preset || defaultPreset

  options.rootDir = resolve(options.rootDir || '.')
  options.workspaceDir = await findWorkspaceDir(options.rootDir)
  options.srcDir = resolve(options.srcDir || options.rootDir)
  for (const key of ['srcDir', 'publicDir', 'buildDir']) {
    options[key] = resolve(options.rootDir, options[key])
  }

  // Add aliases
  options.alias = {
    ...options.alias,
    '~/': join(options.srcDir, '/'),
    '@/': join(options.srcDir, '/'),
    '~~/': join(options.rootDir, '/'),
    '@@/': join(options.rootDir, '/')
  }

  // Resolve possibly template paths
  if (!options.entry) {
    throw new Error(`Nitro entry is missing! Is "${options.preset}" preset correct?`)
  }
  options.entry = resolvePath(options.entry, options)
  options.output.dir = resolvePath(options.output.dir, options)
  options.output.publicDir = resolvePath(options.output.publicDir, options)
  options.output.serverDir = resolvePath(options.output.serverDir, options)

  options.nodeModulesDirs.push(resolve(options.workspaceDir, 'node_modules'))
  options.nodeModulesDirs.push(resolve(options.rootDir, 'node_modules'))
  options.nodeModulesDirs.push(resolve(pkgDir, 'node_modules'))
  options.nodeModulesDirs = Array.from(new Set(options.nodeModulesDirs.map(dir => resolve(options.rootDir, dir))))

  if (!options.scanDirs.length) {
    options.scanDirs = [options.srcDir]
  }

  // Backward compatibility for options.autoImports
  // TODO: Remove in major release
  if (options.autoImport === false) {
    options.imports = false
  } else if (options.imports !== false) {
    options.imports = options.autoImport = defu(options.imports, options.autoImport)
  }

  if (options.imports && Array.isArray(options.imports.exclude)) {
    options.imports.exclude.push(options.buildDir)
  }

  // Add h3 auto imports preset
  if (options.imports) {
    const h3Exports = await resolveModuleExportNames('h3', { url: import.meta.url })
    options.imports.presets.push({
      from: 'h3',
      imports: h3Exports.filter(n => !n.match(/^[A-Z]/) && n !== 'use')
    })
  }

  // Normalize route rules (NitroRouteConfig => NitroRouteOptions)
  const routes: { [p: string]: NitroRouteOptions } = {}
  for (const path in options.routes) {
    const routeConfig = options.routes[path] as NitroRouteConfig
    const routeOptions: NitroRouteOptions = {
      ...routeConfig,
      redirect: undefined
    }
    // Redirect
    if (routeConfig.redirect) {
      routeOptions.redirect = {
        to: '/',
        statusCode: 307,
        ...(typeof routeConfig.redirect === 'string' ? { to: routeConfig.redirect } : routeConfig.redirect)
      }
    }
    // CORS
    if (routeConfig.cors) {
      routeOptions.headers = {
        'access-control-allow-origin': '*',
        'access-control-allowed-methods': '*',
        'access-control-allow-headers': '*',
        'access-control-max-age': '0',
        ...routeOptions.headers
      }
    }
    // Cache: swr
    if (routeConfig.swr) {
      routeOptions.cache = routeOptions.cache || {}
      routeOptions.cache.swr = true
      if (typeof routeConfig.swr === 'number') {
        routeOptions.cache.maxAge = routeConfig.swr
      }
    }
    // Cache: static
    if (routeConfig.static) {
      routeOptions.cache = routeOptions.cache || {}
      routeOptions.cache.static = true
    }
    routes[path] = routeOptions
  }
  options.routes = routes

  options.baseURL = withLeadingSlash(withTrailingSlash(options.baseURL))
  options.runtimeConfig = defu(options.runtimeConfig, {
    app: {
      baseURL: options.baseURL
    },
    nitro: {
      routes: options.routes
    }
  })

  for (const asset of options.publicAssets) {
    asset.dir = resolve(options.srcDir, asset.dir)
    asset.baseURL = withLeadingSlash(withoutTrailingSlash(asset.baseURL || '/'))
  }

  for (const pkg of ['defu', 'h3']) {
    if (!options.alias[pkg]) {
      options.alias[pkg] = await resovleModule(pkg, { url: import.meta.url })
    }
  }

  // Build-only storage
  const fsMounts = {
    root: resolve(options.rootDir),
    src: resolve(options.srcDir),
    build: resolve(options.buildDir),
    cache: resolve(options.buildDir, 'cache')
  }
  for (const p in fsMounts) {
    options.devStorage[p] = options.devStorage[p] || { driver: 'fs', base: fsMounts[p] }
  }

  // Resolve plugin paths
  options.plugins = options.plugins.map(p => resolvePath(p, options))

  return options
}

export function defineNitroConfig (config: NitroConfig): NitroConfig {
  return config
}
