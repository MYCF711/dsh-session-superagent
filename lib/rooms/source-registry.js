/**
 * Source 扩展房：只负责 provider 的注册、查找与能力检查。
 *
 * provider 的网络与凭证仍由 data-provider 的显式端口注入；这里不读环境、
 * 不发起网络请求，也不保存宿主状态。注册表实例之间完全隔离。
 */
import {
  CapabilityError,
  defineProvider,
  requireCapability as requireProviderCapability,
} from './data-provider.js'

export { CapabilityError }

export class SourceRegistryError extends Error {
  constructor(message, code, details = {}) {
    super(message)
    this.name = 'SourceRegistryError'
    this.code = code
    Object.assign(this, details)
  }
}

export class DuplicateProviderError extends SourceRegistryError {
  constructor(provider) {
    super(`provider already registered: ${provider}`, 'PROVIDER_DUPLICATE', { provider })
    this.name = 'DuplicateProviderError'
  }
}

export class ProviderNotFoundError extends SourceRegistryError {
  constructor(provider) {
    super(`provider not registered: ${provider}`, 'PROVIDER_NOT_FOUND', { provider })
    this.name = 'ProviderNotFoundError'
  }
}

function providerName(spec) {
  if (!spec || typeof spec !== 'object') throw new TypeError('provider must be an object')
  const name = typeof spec.name === 'string' ? spec.name.trim() : ''
  if (!name) throw new TypeError('provider name is required')
  return name
}

function normalizeProvider(spec) {
  const name = providerName(spec)
  // defineProvider() 已经产出一个带 capabilities() 的完整 provider。保留它的
  // 对象身份，但重新经过 defineProvider 校验，避免手工伪造对象绕过必需针脚。
  if (typeof spec.capabilities === 'function') {
    const capabilities = spec.capabilities()
    if (!Array.isArray(capabilities)) {
      throw new TypeError(`provider ${name} capabilities() must return an array`)
    }
    defineProvider({ ...spec, name, capabilities })
    return spec
  }
  return defineProvider({ ...spec, name })
}

/** A deterministic, instance-local registry of data-provider implementations. */
export class SourceRegistry {
  #providers = new Map()

  constructor(providers = []) {
    if (providers == null) providers = []
    if (typeof providers[Symbol.iterator] !== 'function') {
      throw new TypeError('SourceRegistry providers must be iterable')
    }
    for (const provider of providers) this.register(provider)
  }

  register(spec) {
    const provider = normalizeProvider(spec)
    if (this.#providers.has(provider.name)) throw new DuplicateProviderError(provider.name)
    this.#providers.set(provider.name, provider)
    return provider
  }

  get(name, capability) {
    const key = typeof name === 'string' ? name.trim() : ''
    const provider = this.#providers.get(key)
    if (!provider) throw new ProviderNotFoundError(key || String(name || 'unknown'))
    if (capability !== undefined) requireProviderCapability(provider, capability)
    return provider
  }

  list() {
    const providers = [...this.#providers.values()]
    providers.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    return Object.freeze(providers)
  }

  requireCapability(name, capability) {
    return requireProviderCapability(this.get(name), capability)
  }
}

export function createSourceRegistry(providers = []) {
  return new SourceRegistry(providers)
}
