import { Observable, Observer, Subject, Subscription } from 'rxjs'

import {
  Args,
  internalToOriginalEvent,
  RemeshCommand,
  RemeshCommandAction,
  RemeshCommandContext,
  RemeshCommandOutput,
  RemeshDomain,
  RemeshDomainAction,
  RemeshDomainContext,
  RemeshDomainDefinition,
  RemeshDomainPreloadCommandContext,
  RemeshDomainPreloadOptions,
  RemeshEffect,
  RemeshEffectContext,
  RemeshEffectOutput,
  RemeshEntity,
  RemeshEntityItem,
  RemeshEntityItemDeletePayload,
  RemeshEvent,
  RemeshEventAction,
  RemeshEventContext,
  RemeshEventOptions,
  RemeshExtern,
  RemeshExternImpl,
  RemeshInjectedContext,
  RemeshQuery,
  RemeshQueryAction,
  RemeshQueryContext,
  RemeshState,
  RemeshStateItem,
  RemeshSubscribeOnlyEvent,
  Serializable,
  SerializableObject,
  toValidRemeshDomainDefinition,
  VerifiedRemeshDomainDefinition,
} from './remesh'

import { createInspectorManager, InspectorType } from './inspector'

export type PreloadedState = Record<string, Serializable>

export type RemeshStore = ReturnType<typeof RemeshStore>

let uid = 0

export type RemeshStateStorage<T> = {
  id: number
  type: 'RemeshStateStorage'
  State: RemeshState<T>
  key: string
  subject: Subject<T>
  observable: Observable<T>
  currentState: T
  downstreamSet: Set<RemeshQueryStorage<any, any>>
}

export type RemeshEntityStorage<T extends SerializableObject> = {
  id: number
  type: 'RemeshEntityStorage'
  Entity: RemeshEntity<T>
  key: string
  subject: Subject<T>
  observable: Observable<T>
  currentEntity: T | null
  downstreamSet: Set<RemeshQueryStorage<any, any>>
}

export type RemeshQueryStorage<T extends Args<Serializable>, U> = {
  id: number
  type: 'RemeshQueryStorage'
  Query: RemeshQuery<T, U>
  arg: T[0]
  key: string
  currentValue: U
  upstreamSet: Set<RemeshQueryStorage<any, any> | RemeshStateStorage<any> | RemeshEntityStorage<any>>
  downstreamSet: Set<RemeshQueryStorage<any, any>>
  subject: Subject<U>
  observable: Observable<U>
  refCount: number
  status: 'default' | 'wip' | 'updated'
  wipUpstreamSet: Set<RemeshQueryStorage<any, any> | RemeshStateStorage<any> | RemeshEntityStorage<any>>
}

export type RemeshCommandStorage<T extends Args> = {
  id: number
  type: 'RemeshCommandStorage'
  Command: RemeshCommand<T>
  subject: Subject<T[0]>
  observable: Observable<T[0]>
}

export type RemeshEventStorage<T extends Args, U> = {
  id: number
  type: 'RemeshEventStorage'
  Event: RemeshEvent<T, U>
  subject: Subject<T[0]>
  observable: Observable<U>
  refCount: number
}

export type RemeshDomainStorage<T extends RemeshDomainDefinition> = {
  id: number
  type: 'RemeshDomainStorage'
  Domain: RemeshDomain<T>
  key: string
  domain: T
  domainContext: RemeshDomainContext
  domainAction: RemeshDomainAction<T>
  upstreamSet: Set<RemeshDomainStorage<any>>
  downstreamSet: Set<RemeshDomainStorage<any>>
  preloadOptionsList: RemeshDomainPreloadOptions<any>[]
  preloadedPromise?: Promise<void>
  preloadedState: PreloadedState
  effectList: RemeshEffect[]
  effectMap: Map<RemeshEffect, Subscription>
  stateMap: Map<string, RemeshStateStorage<any>>
  entityMap: Map<string, RemeshEntityStorage<any>>
  queryMap: Map<string, RemeshQueryStorage<any, any>>
  eventMap: Map<RemeshEvent<any, any>, RemeshEventStorage<any, any>>
  commandMap: Map<RemeshCommand<any>, RemeshCommandStorage<any>>
  running: boolean
}

export type RemeshExternStorage<T> = {
  id: number
  type: 'RemeshExternStorage'
  Extern: RemeshExtern<T>
  currentValue: T
}

export type RemeshStoreInspector = typeof RemeshStore

export type RemeshStoreOptions = {
  name?: string
  externs?: RemeshExternImpl<any>[]
  inspectors?: (RemeshStoreInspector | false | undefined | null)[]
  preloadedState?: PreloadedState
}

export const RemeshStore = (options?: RemeshStoreOptions) => {
  const config = {
    ...options,
  }

  const inspectorManager = createInspectorManager(config)

  const pendingEmitSet = new Set<
    | RemeshQueryStorage<any, any>
    | RemeshStateStorage<any>
    | RemeshEntityStorage<any>
    | RemeshEventAction<any, any>
    | RemeshCommandAction<any>
    | RemeshEntityItemDeletePayload<any>
  >()
  /**
   * Leaf means that the query storage has no downstream query storages
   */
  const pendingLeafSet = new Set<RemeshQueryStorage<any, any>>()
  const pendingClearSet = new Set<RemeshQueryStorage<any, any>>()

  const domainStorageMap = new Map<string, RemeshDomainStorage<any>>()

  const externStorageWeakMap = new WeakMap<RemeshExtern<any>, RemeshExternStorage<any>>()

  const getExternValue = <T>(Extern: RemeshExtern<T>): T => {
    for (const externImpl of config.externs ?? []) {
      if (externImpl.Extern === Extern) {
        return externImpl.value
      }
    }
    return Extern.default
  }

  const getExternStorage = <T>(Extern: RemeshExtern<T>): RemeshExternStorage<T> => {
    const externStorage = externStorageWeakMap.get(Extern)

    if (externStorage) {
      return externStorage
    }

    const currentValue = getExternValue(Extern)

    const currentExternStorage: RemeshExternStorage<T> = {
      id: uid++,
      type: 'RemeshExternStorage',
      Extern,
      currentValue,
    }

    externStorageWeakMap.set(Extern, currentExternStorage)

    return currentExternStorage
  }

  const getExternCurrentValue = <T>(Extern: RemeshExtern<T>): T => {
    return getExternStorage(Extern).currentValue
  }

  const storageKeyWeakMap = new WeakMap<
    RemeshQueryAction<any, any> | RemeshStateItem<any> | RemeshDomainAction<any> | RemeshEntityItem<any>,
    string
  >()

  const getStateStorageKey = <T>(stateItem: RemeshStateItem<T>): string => {
    const key = storageKeyWeakMap.get(stateItem)

    if (key) {
      return key
    }

    const stateName = stateItem.State.stateName
    const keyString = `State/${stateItem.State.stateId}/${stateName}:${stateItem.key ?? ''}`

    storageKeyWeakMap.set(stateItem, keyString)

    return keyString
  }

  const getQueryStorageKey = <T extends Args<Serializable>, U>(queryAction: RemeshQueryAction<T, U>): string => {
    const key = storageKeyWeakMap.get(queryAction)

    if (key) {
      return key
    }

    const queryName = queryAction.Query.queryName
    const argString = JSON.stringify(queryAction.arg) ?? ''
    const keyString = `Query/${queryAction.Query.queryId}/${queryName}:${argString}`

    storageKeyWeakMap.set(queryAction, keyString)

    return keyString
  }

  const getDomainStorageKey = <T extends RemeshDomainDefinition>(domainAction: RemeshDomainAction<T>): string => {
    const key = storageKeyWeakMap.get(domainAction)

    if (key) {
      return key
    }

    const domainName = domainAction.Domain.domainName
    const keyString = `Domain/${domainAction.Domain.domainId}/${domainName}:${domainAction.key ?? ''}`

    storageKeyWeakMap.set(domainAction, keyString)

    return keyString
  }

  const getEntityStorageKey = <T extends SerializableObject>(entityItem: RemeshEntityItem<T>): string => {
    const key = storageKeyWeakMap.get(entityItem)

    if (key) {
      return key
    }

    const entityName = entityItem.Entity.entityName
    const keyString = `Entity/${entityItem.Entity.entityId}/${entityName}:${entityItem.key ?? ''}`

    storageKeyWeakMap.set(entityItem, keyString)

    return keyString
  }

  const getStorageKey = <T extends Args<Serializable>, U, E extends SerializableObject>(
    input:
      | RemeshStateItem<T>
      | RemeshEntityItem<E>
      | RemeshQueryAction<T, U>
      | RemeshDomainAction<RemeshDomainDefinition>,
  ): string => {
    if (input.type === 'RemeshStateItem') {
      return getStateStorageKey(input)
    } else if (input.type === 'RemeshQueryAction') {
      return getQueryStorageKey(input)
    } else if (input.type === 'RemeshEntityItem') {
      return getEntityStorageKey(input)
    }
    return getDomainStorageKey(input)
  }

  const stateStorageWeakMap = new WeakMap<RemeshStateItem<any>, RemeshStateStorage<any>>()

  const getStateValue = <T>(State: RemeshState<T>) => {
    if (typeof State.default === 'function') {
      return (State.default as () => T)()
    }
    return State.default
  }

  const createStateStorage = <T>(stateItem: RemeshStateItem<T>): RemeshStateStorage<T> => {
    const domainStorage = getDomainStorage(stateItem.State.owner)
    const key = getStateStorageKey(stateItem)

    const currentState = getStateValue(stateItem.State)

    const subject = new Subject<T>()

    const observable = subject.asObservable()

    const stateStorage: RemeshStateStorage<T> = {
      id: uid++,
      type: 'RemeshStateStorage',
      State: stateItem.State,
      key,
      subject,
      observable,
      currentState,
      downstreamSet: new Set(),
    }

    domainStorage.stateMap.set(key, stateStorage)
    stateStorageWeakMap.set(stateItem, stateStorage)

    inspectorManager.inspectStateStorage(InspectorType.StateCreated, stateStorage)

    return stateStorage
  }

  const restoreStateStorage = <T>(stateStorage: RemeshStateStorage<T>) => {
    const domainStorage = getDomainStorage(stateStorage.State.owner)

    if (domainStorage.stateMap.has(stateStorage.key)) {
      return
    }

    const subject = new Subject<T>()
    const observable = subject.asObservable()

    stateStorage.subject = subject
    stateStorage.observable = observable
    stateStorage.currentState = getStateValue(stateStorage.State)
    domainStorage.stateMap.set(stateStorage.key, stateStorage)
    inspectorManager.inspectStateStorage(InspectorType.StateReused, stateStorage)
  }

  const getStateStorage = <T>(stateItem: RemeshStateItem<T>): RemeshStateStorage<T> => {
    const domainStorage = getDomainStorage(stateItem.State.owner)
    const key = getStateStorageKey(stateItem)
    const stateStorage = domainStorage.stateMap.get(key)

    if (stateStorage) {
      return stateStorage as RemeshStateStorage<T>
    }

    const cachedStorage = stateStorageWeakMap.get(stateItem)

    if (cachedStorage) {
      restoreStateStorage(cachedStorage)
      return cachedStorage
    }

    return createStateStorage(stateItem)
  }

  const entityStorageWeakMap = new WeakMap<RemeshEntityItem<any>, RemeshEntityStorage<any>>()

  const createEntityStorage = <T extends SerializableObject>(
    entityItem: RemeshEntityItem<T>,
  ): RemeshEntityStorage<T> => {
    const domainStorage = getDomainStorage(entityItem.Entity.owner)
    const key = getStorageKey(entityItem)

    const subject = new Subject<T>()

    const observable = subject.asObservable()

    const newEntityStorage: RemeshEntityStorage<T> = {
      id: uid++,
      type: 'RemeshEntityStorage',
      Entity: entityItem.Entity,
      key,
      subject,
      observable,
      currentEntity: null,
      downstreamSet: new Set(),
    }

    domainStorage.entityMap.set(key, newEntityStorage)
    entityStorageWeakMap.set(entityItem, newEntityStorage)

    inspectorManager.inspectEntityStorage(InspectorType.EntityCreated, newEntityStorage)

    return newEntityStorage
  }

  const restoreEntityStorage = <T extends SerializableObject>(entityStorage: RemeshEntityStorage<T>) => {
    const domainStorage = getDomainStorage(entityStorage.Entity.owner)

    if (domainStorage.entityMap.has(entityStorage.key)) {
      return
    }

    entityStorage.currentEntity = null

    domainStorage.entityMap.set(entityStorage.key, entityStorage)
    inspectorManager.inspectEntityStorage(InspectorType.EntityReused, entityStorage)
  }

  const getEntityStorage = <T extends SerializableObject>(entityItem: RemeshEntityItem<T>): RemeshEntityStorage<T> => {
    const domainStorage = getDomainStorage(entityItem.Entity.owner)
    const key = getStorageKey(entityItem)
    const entityStorage = domainStorage.entityMap.get(key)

    if (entityStorage) {
      return entityStorage as RemeshEntityStorage<T>
    }

    const cachedStorage = entityStorageWeakMap.get(entityItem)

    if (cachedStorage) {
      restoreEntityStorage(cachedStorage)
      return cachedStorage
    }

    return createEntityStorage(entityItem)
  }

  const eventStorageWeakMap = new WeakMap<RemeshEvent<any, any>, RemeshEventStorage<any, any>>()

  const createEventStorage = <T extends Args, U>(Event: RemeshEvent<T, U>): RemeshEventStorage<T, U> => {
    const domainStorage = getDomainStorage(Event.owner)

    const subject = new Subject<T>()

    const eventContext: RemeshEventContext = {
      get: remeshInjectedContext.get,
    }

    const observable = new Observable<U>((subscriber) => {
      const subscription = subject.subscribe((arg) => {
        if (Event.impl) {
          subscriber.next(Event.impl(eventContext, arg))
        } else {
          subscriber.next(arg as unknown as U)
        }
      })

      eventStorage.refCount += 1

      return () => {
        eventStorage.refCount -= 1
        clearEventStorageIfNeeded(eventStorage)
        subscription.unsubscribe()
      }
    })

    const cachedStorage = eventStorageWeakMap.get(Event)

    const eventStorage = Object.assign(cachedStorage ?? {}, {
      id: uid++,
      type: 'RemeshEventStorage',
      Event,
      subject,
      observable,
      refCount: 0,
    } as RemeshEventStorage<T, U>)

    domainStorage.eventMap.set(Event, eventStorage)
    eventStorageWeakMap.set(Event, eventStorage)

    return eventStorage
  }

  const getEventStorage = <T extends Args, U>(Event: RemeshEvent<T, U>): RemeshEventStorage<T, U> => {
    const domainStorage = getDomainStorage(Event.owner)
    const eventStorage = domainStorage.eventMap.get(Event) ?? createEventStorage(Event)

    return eventStorage as RemeshEventStorage<T, U>
  }

  const queryStorageWeakMap = new WeakMap<RemeshQueryAction<any, any>, RemeshQueryStorage<any, any>>()

  const createQuery$ = <T extends Args<Serializable>, U>(get: () => RemeshQueryStorage<T, U>) => {
    const subject = new Subject<U>()

    const observable = new Observable<U>((subscriber) => {
      const subscription = subject.subscribe(subscriber)
      const queryStorage = get()
      queryStorage.refCount += 1

      return () => {
        subscription.unsubscribe()
        queryStorage.refCount -= 1
        clearQueryStorageIfNeeded(queryStorage)
      }
    })

    return {
      subject,
      observable,
    }
  }

  const createQueryStorage = <T extends Args<Serializable>, U>(
    queryAction: RemeshQueryAction<T, U>,
  ): RemeshQueryStorage<T, U> => {
    const domainStorage = getDomainStorage(queryAction.Query.owner)
    const key = getQueryStorageKey(queryAction)

    const { subject, observable } = createQuery$(() => currentQueryStorage)
    const upstreamSet: RemeshQueryStorage<T, U>['upstreamSet'] = new Set()

    const currentQueryStorage = {
      id: uid++,
      type: 'RemeshQueryStorage',
      Query: queryAction.Query,
      arg: queryAction.arg,
      key,
      upstreamSet,
      downstreamSet: new Set(),
      subject,
      observable,
      refCount: 0,
      status: 'default',
      wipUpstreamSet: new Set(),
    } as RemeshQueryStorage<T, U>

    const { Query } = queryAction

    const queryContext: RemeshQueryContext = {
      get: (input: any) => {
        if (currentQueryStorage.upstreamSet !== upstreamSet) {
          return remeshInjectedContext.get(input)
        }

        if (input.type === 'RemeshStateItem') {
          const upstreamStateStorage = getStateStorage(input)

          currentQueryStorage.upstreamSet.add(upstreamStateStorage)
          upstreamStateStorage.downstreamSet.add(currentQueryStorage)

          return remeshInjectedContext.get(input)
        }

        if (input.type === 'RemeshQueryAction') {
          const upstreamQueryStorage = getQueryStorage(input)

          currentQueryStorage.upstreamSet.add(upstreamQueryStorage)
          upstreamQueryStorage.downstreamSet.add(currentQueryStorage)

          return remeshInjectedContext.get(input)
        }

        return remeshInjectedContext.get(input)
      },
    }

    const currentValue = Query.impl(queryContext, queryAction.arg)

    currentQueryStorage.currentValue = currentValue

    domainStorage.queryMap.set(key, currentQueryStorage)
    queryStorageWeakMap.set(queryAction, currentQueryStorage)

    inspectorManager.inspectQueryStorage(InspectorType.QueryCreated, currentQueryStorage)

    return currentQueryStorage
  }

  const restoreQueryStorage = <T extends Args<Serializable>, U>(queryStorage: RemeshQueryStorage<T, U>) => {
    const domainStorage = getDomainStorage(queryStorage.Query.owner)

    if (domainStorage.queryMap.has(queryStorage.key)) {
      return
    }

    const { subject, observable } = createQuery$(() => queryStorage)

    queryStorage.status = 'default'
    queryStorage.subject = subject
    queryStorage.observable = observable
    domainStorage.queryMap.set(queryStorage.key, queryStorage)

    for (const upstream of queryStorage.upstreamSet) {
      upstream.downstreamSet.add(queryStorage)
      if (upstream.type === 'RemeshQueryStorage') {
        restoreQueryStorage(upstream)
      } else if (upstream.type === 'RemeshStateStorage') {
        restoreStateStorage(upstream)
      } else {
        throw new Error(`Unknown upstream: ${upstream}`)
      }
    }

    updateQueryStorage(queryStorage)
    inspectorManager.inspectQueryStorage(InspectorType.QueryReused, queryStorage)
  }

  const getQueryStorage = <T extends Args<Serializable>, U>(
    queryAction: RemeshQueryAction<T, U>,
  ): RemeshQueryStorage<T, U> => {
    const domainStorage = getDomainStorage(queryAction.Query.owner)
    const key = getQueryStorageKey(queryAction)
    const queryStorage = domainStorage.queryMap.get(key)

    if (queryStorage) {
      return queryStorage
    }

    const cachedStorage = queryStorageWeakMap.get(queryAction)

    if (cachedStorage) {
      restoreQueryStorage(cachedStorage)
      return cachedStorage
    }

    return createQueryStorage(queryAction)
  }

  const createCommandStorage = <T extends Args>(Command: RemeshCommand<T>): RemeshCommandStorage<T> => {
    const domainStorage = getDomainStorage(Command.owner)

    const subject = new Subject<T[0]>()

    const observable = subject.asObservable()

    const currentCommandStorage: RemeshCommandStorage<T> = {
      id: uid++,
      type: 'RemeshCommandStorage',
      Command,
      subject,
      observable,
      refCount: 0,
    }

    domainStorage.commandMap.set(Command, currentCommandStorage)

    return currentCommandStorage
  }

  const getCommandStorage = <T extends Args>(Command: RemeshCommand<T>): RemeshCommandStorage<T> => {
    const domainStorage = getDomainStorage(Command.owner)

    if (domainStorage.commandMap.has(Command)) {
      return domainStorage.commandMap.get(Command) as RemeshCommandStorage<T>
    }

    return createCommandStorage(Command)
  }

  const domainStorageWeakMap = new WeakMap<RemeshDomainAction<any>, RemeshDomainStorage<any>>()

  const createDomainStorage = <T extends RemeshDomainDefinition>(
    domainAction: RemeshDomainAction<T>,
  ): RemeshDomainStorage<T> => {
    const key = getDomainStorageKey(domainAction)

    const upstreamSet: RemeshDomainStorage<T>['upstreamSet'] = new Set()

    const domainContext: RemeshDomainContext = {
      key: domainAction.key,
      state: (options) => {
        const State = RemeshState(options)
        State.owner = domainAction
        return State
      },
      entity: (options) => {
        const Entity = RemeshEntity(options)
        Entity.owner = domainAction
        return Entity
      },
      query: (options) => {
        const Query = RemeshQuery(options)
        Query.owner = domainAction
        return Query
      },
      event: (options: Omit<RemeshEventOptions<any, any>, 'impl'> | RemeshEventOptions<any, any>) => {
        const Event = RemeshEvent(options)
        Event.owner = domainAction
        return Event as RemeshEvent<any, any>
      },
      command: (options) => {
        const Command = RemeshCommand(options)
        Command.owner = domainAction
        return Command
      },
      effect: (effect) => {
        if (!currentDomainStorage.running) {
          currentDomainStorage.effectList.push(effect)
        }
      },
      preload: (preloadOptions) => {
        if (!currentDomainStorage.running) {
          currentDomainStorage.preloadOptionsList.push(preloadOptions)
        }
      },
      getDomain: <T extends RemeshDomainDefinition>(upstreamDomainAction: RemeshDomainAction<T>) => {
        const upstreamDomainStorage = getDomainStorage(upstreamDomainAction)

        upstreamSet.add(upstreamDomainStorage)
        upstreamDomainStorage.downstreamSet.add(currentDomainStorage)

        return upstreamDomainStorage.domain as unknown as VerifiedRemeshDomainDefinition<T>
      },
      getExtern: (Extern) => {
        return getExternCurrentValue(Extern)
      },
    }

    const currentDomainStorage: RemeshDomainStorage<T> = {
      id: uid++,
      type: 'RemeshDomainStorage',
      Domain: domainAction.Domain,
      get domain() {
        return domain
      },
      domainContext,
      domainAction,
      key,
      upstreamSet,
      downstreamSet: new Set(),
      effectList: [],
      stateMap: new Map(),
      entityMap: new Map(),
      queryMap: new Map(),
      eventMap: new Map(),
      effectMap: new Map(),
      commandMap: new Map(),
      preloadOptionsList: [],
      preloadedState: {},
      refCount: 0,
      running: false,
    }

    const domain = domainAction.Domain.impl(domainContext)

    domainStorageMap.set(key, currentDomainStorage)
    domainStorageWeakMap.set(domainAction, currentDomainStorage)

    inspectorManager.inspectDomainStorage(InspectorType.DomainCreated, currentDomainStorage)

    injectPreloadState(currentDomainStorage)

    return currentDomainStorage
  }

  const injectPreloadState = <T extends RemeshDomainDefinition>(domainStorage: RemeshDomainStorage<T>) => {
    if (!options?.preloadedState) {
      return
    }

    const preloadCommandContext = {
      get: remeshInjectedContext.get,
    }

    for (const preloadOptions of domainStorage.preloadOptionsList) {
      if (Object.prototype.hasOwnProperty.call(options.preloadedState, preloadOptions.key)) {
        const data = options.preloadedState[preloadOptions.key]
        handleCommandOutput(preloadOptions.command(preloadCommandContext, data))
      }
    }
  }

  const getDomainStorage = <T extends RemeshDomainDefinition>(
    domainAction: RemeshDomainAction<T>,
  ): RemeshDomainStorage<T> => {
    const key = getDomainStorageKey(domainAction)
    const domainStorage = domainStorageMap.get(key)

    if (domainStorage) {
      return domainStorage
    }

    const cachedStorage = domainStorageWeakMap.get(domainAction)

    if (cachedStorage) {
      cachedStorage.running = false
      domainStorageMap.set(cachedStorage.key, cachedStorage)

      for (const upstreamDomainStorage of cachedStorage.upstreamSet) {
        upstreamDomainStorage.downstreamSet.add(cachedStorage)
      }

      inspectorManager.inspectDomainStorage(InspectorType.DomainReused, cachedStorage)
      return cachedStorage
    }

    return createDomainStorage(domainAction)
  }

  const clearQueryStorage = <T extends Args<Serializable>, U>(queryStorage: RemeshQueryStorage<T, U>) => {
    const domainStorage = getDomainStorage(queryStorage.Query.owner)

    if (!domainStorage.queryMap.has(queryStorage.key)) {
      return
    }

    domainStorage.queryMap.delete(queryStorage.key)

    inspectorManager.inspectQueryStorage(InspectorType.QueryDiscarded, queryStorage)

    for (const upstreamStorage of queryStorage.upstreamSet) {
      upstreamStorage.downstreamSet.delete(queryStorage)

      if (upstreamStorage.type === 'RemeshQueryStorage') {
        clearQueryStorageIfNeeded(upstreamStorage)
      }
    }

    queryStorage.subject.complete()

    clearDomainStorageIfNeeded(domainStorage)
  }

  const shouldClearQueryStorage = <T extends Args<Serializable>, U>(
    queryStorage: RemeshQueryStorage<T, U>,
  ): boolean => {
    if (queryStorage.refCount > 0) {
      return false
    }

    if (queryStorage.downstreamSet.size !== 0) {
      return false
    }

    return true
  }

  const clearQueryStorageIfNeeded = <T extends Args<Serializable>, U>(queryStorage: RemeshQueryStorage<T, U>) => {
    if (shouldClearQueryStorage(queryStorage)) {
      clearQueryStorage(queryStorage)
    }
  }

  const clearStateStorage = <T>(stateStorage: RemeshStateStorage<T>) => {
    const domainStorage = getDomainStorage(stateStorage.State.owner)

    if (!domainStorage.stateMap.has(stateStorage.key)) {
      return
    }

    inspectorManager.inspectStateStorage(InspectorType.StateDiscarded, stateStorage)
    domainStorage.stateMap.delete(stateStorage.key)
    stateStorage.downstreamSet.clear()
    stateStorage.subject.complete()
  }

  const clearEntityStorage = <T extends SerializableObject>(entityStorage: RemeshEntityStorage<T>) => {
    const domainStorage = getDomainStorage(entityStorage.Entity.owner)

    if (!domainStorage.entityMap.has(entityStorage.key)) {
      return
    }

    inspectorManager.inspectEntityStorage(InspectorType.EntityDiscarded, entityStorage)
    domainStorage.entityMap.delete(entityStorage.key)
    entityStorage.subject.complete()

    for (const downstream of entityStorage.downstreamSet) {
      mark(downstream)
    }

    entityStorage.downstreamSet.clear()
    entityStorage.currentEntity = null
  }

  const clearEventStorage = <T extends Args, U>(eventStorage: RemeshEventStorage<T, U>) => {
    const domainStorage = getDomainStorage(eventStorage.Event.owner)

    eventStorage.subject.complete()
    domainStorage.eventMap.delete(eventStorage.Event)

    clearDomainStorageIfNeeded(domainStorage)
  }

  const shouldClearEventStorage = <T extends Args, U>(eventStorage: RemeshEventStorage<T, U>): boolean => {
    if (eventStorage.refCount > 0) {
      return false
    }
    return true
  }

  const clearEventStorageIfNeeded = <T extends Args, U>(eventStorage: RemeshEventStorage<T, U>) => {
    if (shouldClearEventStorage(eventStorage)) {
      clearEventStorage(eventStorage)
    }
  }

  const clearDomainStorage = <T extends RemeshDomainDefinition>(domainStorage: RemeshDomainStorage<T>) => {
    if (!domainStorage.running) {
      return
    }

    domainStorage.running = false

    inspectorManager.inspectDomainStorage(InspectorType.DomainDiscarded, domainStorage)

    for (const eventStorage of domainStorage.eventMap.values()) {
      clearEventStorage(eventStorage)
    }

    for (const queryStorage of domainStorage.queryMap.values()) {
      clearQueryStorage(queryStorage)
    }

    for (const stateStorage of domainStorage.stateMap.values()) {
      clearStateStorage(stateStorage)
    }

    for (const entityStorage of domainStorage.entityMap.values()) {
      clearEntityStorage(entityStorage)
    }

    for (const subscription of domainStorage.effectMap.values()) {
      subscription.unsubscribe()
    }

    domainStorage.downstreamSet.clear()
    domainStorage.stateMap.clear()
    domainStorage.queryMap.clear()
    domainStorage.eventMap.clear()
    domainStorage.effectMap.clear()

    domainStorageMap.delete(domainStorage.key)

    for (const upstreamDomainStorage of domainStorage.upstreamSet) {
      upstreamDomainStorage.downstreamSet.delete(domainStorage)
      clearDomainStorageIfNeeded(upstreamDomainStorage)
    }
  }

  const shouldClearDomainStorage = <T extends RemeshDomainDefinition>(
    domainStorage: RemeshDomainStorage<T>,
  ): boolean => {
    if (domainStorage.downstreamSet.size !== 0) {
      return false
    }

    /**
     * we only check the refCount of queryStorage and eventStorage
     * when their refCount is 0, it means there is no consumers outside of the domain
     * so the domain resources can be cleared
     */
    for (const queryStorage of domainStorage.queryMap.values()) {
      if (queryStorage.refCount > 0) {
        return false
      }
    }

    for (const eventStorage of domainStorage.eventMap.values()) {
      if (eventStorage.refCount > 0) {
        return false
      }
    }

    return true
  }

  const clearDomainStorageIfNeeded = <T extends RemeshDomainDefinition>(domainStorage: RemeshDomainStorage<T>) => {
    if (shouldClearDomainStorage(domainStorage)) {
      clearDomainStorage(domainStorage)
    }
  }

  const getCurrentState = <T>(stateItem: RemeshStateItem<T>): T => {
    const stateStorage = getStateStorage(stateItem)

    return stateStorage.currentState
  }

  const getCurrentQueryValue = <T extends Args<Serializable>, U>(queryAction: RemeshQueryAction<T, U>): U => {
    const queryStorage = getQueryStorage(queryAction)

    updateWipQueryStorage(queryStorage)

    const currentValue = queryStorage.currentValue

    return currentValue
  }

  const getCurrentEntity = <T extends SerializableObject>(entityItem: RemeshEntityItem<T>): T => {
    const entityStorage = getEntityStorage(entityItem)

    if (entityStorage.currentEntity === null) {
      throw new Error(`The ${entityStorage.key} of ${entityItem.Entity.entityName} is not created yet.`)
    }

    return entityStorage.currentEntity
  }

  const remeshInjectedContext: RemeshInjectedContext = {
    get: (input: RemeshStateItem<any> | RemeshEntityItem<any> | RemeshQueryAction<any, any>) => {
      if (input.type === 'RemeshStateItem') {
        return getCurrentState(input)
      }

      if (input.type === 'RemeshQueryAction') {
        return getCurrentQueryValue(input)
      }

      if (input.type === 'RemeshEntityItem') {
        return getCurrentEntity(input)
      }

      throw new Error(`Unexpected input in ctx.get(..): ${input}`)
    },
    fromEvent: (Event) => {
      if (Event.type === 'RemeshEvent') {
        const eventStorage = getEventStorage(Event)
        return eventStorage.observable
      } else if (Event.type === 'RemeshSubscribeOnlyEvent') {
        const OriginalEvent = internalToOriginalEvent(Event)
        const eventStorage = getEventStorage(OriginalEvent)
        return eventStorage.observable
      }

      throw new Error(`Unexpected input in fromEvent(..): ${Event}`)
    },
    fromQuery: (queryAction) => {
      const queryStorage = getQueryStorage(queryAction)
      return queryStorage.observable
    },
    fromEntity: (entityItem) => {
      const entityStorage = getEntityStorage(entityItem)
      return entityStorage.observable
    },
    fromState: (stateItem) => {
      const stateStorage = getStateStorage(stateItem)
      return stateStorage.observable
    },
    fromCommand: (Command) => {
      const commandStorage = getCommandStorage(Command)
      return commandStorage.observable
    },
  }

  const updateWipQueryStorage = <T extends Args<Serializable>, U>(queryStorage: RemeshQueryStorage<T, U>) => {
    if (queryStorage.status !== 'wip') {
      return
    }

    if (queryStorage.wipUpstreamSet.size !== 0) {
      let shouldUpdate = false

      for (const upstream of queryStorage.wipUpstreamSet) {
        if (upstream.type === 'RemeshStateStorage') {
          shouldUpdate = true
        } else if (upstream.type === 'RemeshQueryStorage') {
          if (upstream.status === 'wip') {
            updateWipQueryStorage(upstream)
          }
          if (upstream.status === 'updated') {
            shouldUpdate = true
          }
        }
      }

      queryStorage.wipUpstreamSet.clear()

      if (!shouldUpdate) {
        queryStorage.status = 'default'
        return
      }
    }

    const isUpdated = updateQueryStorage(queryStorage)

    if (isUpdated) {
      queryStorage.status = 'updated'
    } else {
      queryStorage.status = 'default'
    }
  }

  const updateQueryStorage = <T extends Args<Serializable>, U>(queryStorage: RemeshQueryStorage<T, U>) => {
    const { Query } = queryStorage

    for (const upstream of queryStorage.upstreamSet) {
      upstream.downstreamSet.delete(queryStorage)
      if (upstream.downstreamSet.size === 0) {
        /**
         * Entity should be deleted manually, cannot be cleared automatically
         */
        if (upstream.type === 'RemeshQueryStorage') {
          pendingClearSet.add(upstream)
        }
      }
    }

    const upstreamSet: RemeshQueryStorage<T, U>['upstreamSet'] = new Set()

    queryStorage.upstreamSet = upstreamSet

    const queryContext: RemeshQueryContext = {
      get: (input: RemeshStateItem<any> | RemeshEntityItem<any> | RemeshQueryAction<any, any>) => {
        if (queryStorage.upstreamSet !== upstreamSet) {
          return remeshInjectedContext.get(input)
        }

        if (input.type === 'RemeshStateItem') {
          const upstreamStateStorage = getStateStorage(input)

          queryStorage.upstreamSet.add(upstreamStateStorage)
          upstreamStateStorage.downstreamSet.add(queryStorage)

          return remeshInjectedContext.get(input)
        }

        if (input.type === 'RemeshEntityItem') {
          const upstreamEntityStorage = getEntityStorage(input)

          queryStorage.upstreamSet.add(upstreamEntityStorage)
          upstreamEntityStorage.downstreamSet.add(queryStorage)

          return remeshInjectedContext.get(input)
        }

        if (input.type === 'RemeshQueryAction') {
          const upstreamQueryStorage = getQueryStorage(input)

          queryStorage.upstreamSet.add(upstreamQueryStorage)
          upstreamQueryStorage.downstreamSet.add(queryStorage)

          return remeshInjectedContext.get(input)
        }

        return remeshInjectedContext.get(input)
      },
    }

    const newValue = Query.impl(queryContext, queryStorage.arg)

    const isEqual = Query.compare(queryStorage.currentValue, newValue)

    if (isEqual) {
      return false
    }

    queryStorage.currentValue = newValue
    pendingEmitSet.add(queryStorage)

    inspectorManager.inspectQueryStorage(InspectorType.QueryUpdated, queryStorage)

    return true
  }

  const clearPendingStorageSetIfNeeded = () => {
    if (pendingClearSet.size === 0) {
      return
    }

    const storageList = [...pendingClearSet]

    pendingClearSet.clear()

    for (const storage of storageList) {
      clearQueryStorageIfNeeded(storage)
    }

    clearPendingStorageSetIfNeeded()
  }

  const clearPendingEmitSetIfNeeded = () => {
    if (pendingEmitSet.size === 0) {
      return
    }

    const list = [...pendingEmitSet]

    pendingEmitSet.clear()

    for (const item of list) {
      if (!pendingEmitSet.has(item)) {
        if (item.type === 'RemeshQueryStorage') {
          item.subject.next(item.currentValue)
        } else if (item.type === 'RemeshStateStorage') {
          item.subject.next(item.currentState)
        } else if (item.type === 'RemeshEntityStorage') {
          item.subject.next(item.currentEntity)
        } else if (item.type === 'RemeshEntityItemDeletePayload') {
          const entityStorage = getEntityStorage(item.entityItem)
          clearEntityStorage(entityStorage)
        } else if (item.type === 'RemeshEventAction') {
          emitEvent(item)
        } else if (item.type === 'RemeshCommandAction') {
          const commandStorage = getCommandStorage(item.Command)
          commandStorage.subject.next(item.arg)
        }
      }
    }

    /**
     * recursively consuming dynamic set until it become empty.
     */
    clearPendingEmitSetIfNeeded()
  }

  const mark = <T extends Args<Serializable>, U>(queryStorage: RemeshQueryStorage<T, U>) => {
    queryStorage.status = 'wip'

    if (queryStorage.downstreamSet.size > 0) {
      for (const downstream of queryStorage.downstreamSet) {
        if (!downstream.wipUpstreamSet.has(queryStorage)) {
          downstream.wipUpstreamSet.add(queryStorage)
          mark(downstream)
        }
      }
    } else {
      pendingLeafSet.add(queryStorage)
    }
  }

  const clearPendingLeafSetIfNeeded = () => {
    if (pendingLeafSet.size === 0) {
      return
    }

    const queryStorageList = [...pendingLeafSet]

    pendingLeafSet.clear()

    for (const queryStorage of queryStorageList) {
      updateWipQueryStorage(queryStorage)
    }

    /**
     * recursively consuming dynamic set until it become empty.
     */
    clearPendingLeafSetIfNeeded()
  }

  const commit = () => {
    clearPendingLeafSetIfNeeded()
    clearPendingStorageSetIfNeeded()
    clearPendingEmitSetIfNeeded()
  }

  let currentTick = 0
  const commitOnNextTick = () => {
    let tick = currentTick++

    Promise.resolve().then(() => {
      if (tick === currentTick) {
        commit()
      }
    })
  }

  const updateStateItem = <T>(stateItem: RemeshStateItem<T>, newState: T) => {
    const stateStorage = getStateStorage(stateItem)

    const isEqual = stateItem.State.compare(stateStorage.currentState, newState)

    if (isEqual) {
      return
    }

    stateStorage.currentState = newState
    pendingEmitSet.add(stateStorage)

    inspectorManager.inspectStateStorage(InspectorType.StateUpdated, stateStorage)

    for (const downstream of stateStorage.downstreamSet) {
      downstream.wipUpstreamSet.add(stateStorage)
      mark(downstream)
    }
  }

  const updateEntityItem = <T extends SerializableObject>(entityItem: RemeshEntityItem<T>, newEntity: T) => {
    const entityStorage = getEntityStorage(entityItem)

    if (entityStorage.currentEntity === null) {
      entityStorage.currentEntity = newEntity
      return
    }

    const isEqual = entityItem.Entity.compare(entityStorage.currentEntity, newEntity)

    if (isEqual) {
      return
    }

    entityStorage.currentEntity = newEntity
    pendingEmitSet.add(entityStorage)

    inspectorManager.inspectEntityStorage(InspectorType.EntityUpdated, entityStorage)

    for (const downstream of entityStorage.downstreamSet) {
      downstream.wipUpstreamSet.add(entityStorage)
      mark(downstream)
    }
  }

  const emitEvent = <T extends Args, U>(eventAction: RemeshEventAction<T, U>) => {
    const { Event, arg } = eventAction
    const eventStorage = getEventStorage(Event)

    inspectorManager.inspectEventEmitted(InspectorType.EventEmitted, eventAction)

    eventStorage.subject.next(arg)
  }

  const commandContext: RemeshCommandContext = {
    get: remeshInjectedContext.get,
  }

  const handleCommandAction = <T extends Args>(commandAction: RemeshCommandAction<T>) => {
    inspectorManager.inspectCommandReceived(InspectorType.CommandReceived, commandAction)

    const { Command, arg } = commandAction

    const fn = Command.impl as (context: RemeshCommandContext, arg: T[0]) => void

    pendingEmitSet.add(commandAction)
    handleCommandOutput(fn(commandContext, arg))
  }

  const deleteEntityItem = <T extends SerializableObject>(
    entityItemDeletePayload: RemeshEntityItemDeletePayload<T>,
  ) => {
    const entityStorage = getEntityStorage(entityItemDeletePayload.entityItem)

    entityStorage.currentEntity = null

    for (const downstream of entityStorage.downstreamSet) {
      mark(downstream)
    }

    entityStorage.downstreamSet.clear()
    pendingEmitSet.add(entityItemDeletePayload)
  }

  const handleCommandOutput = (output: RemeshCommandOutput) => {
    if (!output) {
      return
    } else if (Array.isArray(output)) {
      for (const item of output) {
        handleCommandOutput(item)
      }
    } else if (output.type === 'RemeshCommandAction') {
      handleCommandAction(output)
    } else if (output.type === 'RemeshStateItemUpdatePayload') {
      updateStateItem(output.stateItem, output.value)
    } else if (output.type === 'RemeshEntityItemUpdatePayload') {
      updateEntityItem(output.entityItem, output.value)
    } else if (output.type === 'RemeshEntityItemDeletePayload') {
      deleteEntityItem(output)
    } else if (output.type === 'RemeshEventAction') {
      pendingEmitSet.add(output)
    }
  }

  const subscribeQuery = <T extends Args<Serializable>, U>(
    queryAction: RemeshQueryAction<T, U>,
    subscriber: ((data: U) => unknown) | Partial<Observer<U>>,
  ): Subscription => {
    const queryStorage = getQueryStorage(queryAction)
    const subscription =
      typeof subscriber === 'function'
        ? queryStorage.observable.subscribe(subscriber)
        : queryStorage.observable.subscribe(subscriber)

    return subscription
  }

  const subscribeEvent = <T extends Args, U>(
    Event: RemeshEvent<T, U> | RemeshSubscribeOnlyEvent<T, U>,
    subscriber: (event: U) => unknown,
  ): Subscription => {
    if (Event.type === 'RemeshEvent') {
      const eventStorage = getEventStorage(Event)
      const subscription = eventStorage.observable.subscribe(subscriber)

      return subscription
    } else if (Event.type === 'RemeshSubscribeOnlyEvent') {
      const OriginalEvent = internalToOriginalEvent(Event)
      return subscribeEvent(OriginalEvent, subscriber)
    }

    throw new Error(`Unknown event type of ${Event}`)
  }

  const getDomain = <T extends RemeshDomainDefinition>(domainAction: RemeshDomainAction<T>) => {
    const domainStorage = getDomainStorage(domainAction)

    const domain = domainStorage.domain

    const domainOutput = toValidRemeshDomainDefinition(domain)

    return domainOutput
  }

  const effectContext: RemeshEffectContext = {
    get: remeshInjectedContext.get,
    fromEvent: remeshInjectedContext.fromEvent,
    fromQuery: remeshInjectedContext.fromQuery,
    fromState: remeshInjectedContext.fromState,
    fromEntity: remeshInjectedContext.fromEntity,
    fromCommand: remeshInjectedContext.fromCommand,
  }

  const handleEffectOutput = (output: RemeshEffectOutput) => {
    handleCommandOutput(output)
    commitOnNextTick()
  }

  const igniteDomainStorageIfNeeded = <T extends RemeshDomainDefinition>(domainStorage: RemeshDomainStorage<T>) => {
    if (domainStorage.running) {
      return
    }

    domainStorage.running = true

    for (const effect of domainStorage.effectList) {
      const subscription = effect(effectContext).subscribe(handleEffectOutput)
      domainStorage.effectMap.set(effect, subscription)
    }
  }

  const discard = () => {
    inspectorManager.destroyInspectors()

    for (const domainStorage of domainStorageMap.values()) {
      clearDomainStorage(domainStorage)
    }
    domainStorageMap.clear()
    pendingEmitSet.clear()
  }

  const preload = <T extends RemeshDomainDefinition>(domainAction: RemeshDomainAction<T>) => {
    const domainStorage = getDomainStorage(domainAction)

    if (domainStorage.running) {
      throw new Error(`Domain ${domainAction.Domain.domainName} was ignited before preloading`)
    }

    if (domainStorage.preloadedPromise) {
      return domainStorage.preloadedPromise
    }

    const preloadedPromise = preloadDomain(domainAction)

    domainStorage.preloadedPromise = preloadedPromise

    return preloadedPromise
  }

  const domainPreloadCommandContext: RemeshDomainPreloadCommandContext = {
    get: remeshInjectedContext.get,
  }

  const domainPreloadQueryContext: RemeshQueryContext = {
    get: remeshInjectedContext.get,
  }

  const preloadDomain = async <T extends RemeshDomainDefinition>(domainAction: RemeshDomainAction<T>) => {
    const domainStorage = getDomainStorage(domainAction)

    await Promise.all(
      Array.from(domainStorage.upstreamSet).map((upstreamDomainStorage) => {
        return preload(upstreamDomainStorage.domainAction)
      }),
    )

    await Promise.all(
      domainStorage.preloadOptionsList.map(async (preloadOptions) => {
        const data = await preloadOptions.query(domainPreloadQueryContext)

        if (Object.prototype.hasOwnProperty.call(domainStorage.preloadedState, preloadOptions.key)) {
          throw new Error(`Duplicate key ${preloadOptions.key}`)
        }

        domainStorage.preloadedState[preloadOptions.key] = data

        preloadOptions.command(domainPreloadCommandContext, data)
      }),
    )
  }

  const getPreloadedState = () => {
    const preloadedState = {} as PreloadedState

    for (const domainStorage of domainStorageMap.values()) {
      Object.assign(preloadedState, domainStorage.preloadedState)
    }

    return preloadedState
  }

  const getDomainPreloadedState = <T extends RemeshDomainDefinition>(
    domainAction: RemeshDomainAction<T>,
  ): PreloadedState => {
    const domainStorage = getDomainStorage(domainAction)

    return domainStorage.preloadedState
  }

  const send = (output: RemeshCommandOutput) => {
    handleCommandOutput(output)
    commit()
  }

  return {
    name: config.name,
    getDomain,
    igniteDomain: igniteDomainStorageIfNeeded,
    query: getCurrentQueryValue,
    send,
    discard,
    preload,
    getPreloadedState,
    getDomainPreloadedState,
    subscribeQuery,
    subscribeEvent,
    getKey: getStorageKey,
  }
}
