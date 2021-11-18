import axios, { AxiosInstance, AxiosResponse, AxiosRequestConfig } from 'axios'
import { EventEmitter } from 'events'
import { BIKETAG_API_PREFIX } from './common/endpoints'
import {
  Credentials,
  Tag,
  GameData,
  BikeTagApiResponse,
  ImgurCredentials,
  SanityCredentials,
  RedditCredentials,
  RequireAtLeastOne,
  BikeTagCredentials,
  BikeTagConfiguration,
  PartialBikeTagConfiguration,
  AvailableApis,
  TwitterCredentials,
  BikTagGunClient,
  BikeTagState,
} from './common/types'
import {
  getTagPayload,
  getTagsPayload,
  updateTagPayload,
  getGamePayload,
  uploadTagImagePayload,
  deleteTagPayload,
  deleteTagsPayload,
  importTagPayload,
} from './common/payloads'
import {
  constructTagNumberSlug,
  assignBikeTagConfiguration,
  isImgurCredentials,
  isRedditCredentials,
  isSanityCredentials,
  isBikeTagCredentials,
  isBikeTagApiReady,
  isSanityApiReady,
  isImgurApiReady,
  isRedditApiReady,
  createBikeTagCredentials,
  createImgurCredentials,
  createSanityCredentials,
  createRedditCredentials,
  createTwitterCredentials,
  isTwitterCredentials,
  isTwitterApiReady,
} from './common/methods'
import { setup } from 'axios-cache-adapter'
import { isEqual } from 'lodash'
import * as BikeTagExpressions from './common/expressions'
import * as BikeTagGetters from './common/getters'
import * as sanityApi from './sanity'
import * as imgurApi from './imgur'
import * as biketagApi from './biketag'
import * as redditApi from './reddit'
import * as twitterApi from './twitter'

import RedditClient from 'snoowrap'
import ImgurClient from 'imgur'
import sanityClient, { SanityClient } from '@sanity/client'
import TwitterClient from 'twitter-v2'
import Gun from 'gun'

export const USERAGENT =
  'biketag-api (https://github.com/keneucker/biketag-api)'
export class BikeTagClient extends EventEmitter {
  expressions: any = BikeTagExpressions
  getters: any = BikeTagGetters

  private fetcher: AxiosInstance
  private plainFetcher: AxiosInstance
  private cachedFetcher: AxiosInstance

  private mostAvailableApi: AvailableApis
  private biketagClient?: BikTagGunClient
  private imgurClient?: ImgurClient
  private sanityClient?: SanityClient
  private redditClient?: RedditClient
  private twitterClient?: any
  private sanityConfig?: SanityCredentials
  private imgurConfig?: ImgurCredentials
  private redditConfig?: RedditCredentials
  private biketagConfig?: BikeTagCredentials
  private twitterConfig?: TwitterCredentials

  constructor(readonly configuration: Credentials | BikeTagConfiguration) {
    super()

    this.mostAvailableApi = undefined

    const initConfig = this.config(configuration ?? {}, true, true)
    this.initializeClients(initConfig)

    /// Configure separate fetching strategies: plain, authed (default), cached (authed)
    this.plainFetcher = axios.create({
      headers: {
        'user-agent': USERAGENT,
      },
      responseType: 'json',
    })

    this.fetcher = axios.create({
      baseURL: BIKETAG_API_PREFIX,
      headers: {
        'user-agent': USERAGENT,
      },
      responseType: 'json',
    })

    this.cachedFetcher = setup({
      baseURL: BIKETAG_API_PREFIX,
      cache: {
        maxAge: 15 * 60 * 1000,
        exclude: {
          // Only exclude PUT, PATCH and DELETE methods from cache
          methods: ['put', 'patch', 'delete'],
        },
      },
      headers: {
        'user-agent': USERAGENT,
      },
      responseType: 'json',
    })
  }

  private getDefaultOptions(
    opts: any,
    optsType = 'tag',
    source?: AvailableApis | string
  ): any {
    /// If the options passed in was a string, set it as the slug
    const options =
      typeof opts === 'string'
        ? { slug: opts }
        : typeof opts === 'number' && optsType === 'tag'
        ? { tagnumber: opts }
        : Array.isArray(opts) && optsType === 'tag'
        ? { tagnumbers: opts }
        : Array.isArray(opts)
        ? { payload: opts }
        : opts ?? {}

    if (typeof source === 'string') {
      options.source = AvailableApis[source]
    } else if (typeof source === 'undefined') {
      options.source = this.getMostAvailableAPI()
    } else {
      options.source = source
    }

    switch (optsType) {
      case 'game':
        options.game = options.game ?? options.slug
        options.slug = options.slug ?? options.game?.toLowerCase() ?? undefined
        break

      case 'tag':
        /// Set the game in the options, defaulting to the configured game
        options.game = options.game ? options.game : this.biketagConfig.game

        if (!options.slug) {
          if (options.tagnumber && typeof options.tagnumber !== 'undefined') {
            options.slug = constructTagNumberSlug(
              options.tagnumber,
              options.game
            )
          } else {
            options.slug = 'latest'
          }
        }

        /// Explicitely set the number if we happen to have the slug but not the tagnumber
        if (!options.tagnumber) {
          if (options.slug !== 'latest') {
            options.tagnumber = BikeTagGetters.getTagnumberFromSlug(
              options.slug
            )
          }
        }
        break
    }

    switch (options.source) {
      case AvailableApis.imgur:
        options.hash = options.hash ?? this.imgurConfig.hash
        break
      case AvailableApis.reddit:
        options.subreddit = options.subreddit ?? this.redditConfig.subreddit
        break
      case AvailableApis.twitter:
        options.account = options.account ?? this.twitterConfig.account
        break
    }

    return options
  }

  private getDefaultAPI(
    opts: any = {},
    overloads: any = {},
    getOptionsDefault: string | undefined = undefined
  ) {
    const initialSource = overloads.source ?? this.getMostAvailableAPI()
    delete overloads.source
    const options = {
      ...this.getDefaultOptions(opts, getOptionsDefault, initialSource),
      ...overloads,
    }

    let client: any = null
    let api: any = null

    switch (options.source) {
      case AvailableApis.sanity:
        client = this.sanityClient
        api = sanityApi
        break
      case AvailableApis.imgur:
        client = this.imgurClient
        api = imgurApi
        break
      case AvailableApis.reddit:
        client = this.redditClient
        api = redditApi
        break
      case AvailableApis.twitter:
        client = this.twitterClient
        api = twitterApi
        break
      default:
      case AvailableApis.biketag:
        client = api = biketagApi
        break
    }

    return {
      client,
      api,
      options,
    }
  }

  private getMostAvailableAPI(): AvailableApis {
    if (this.mostAvailableApi) {
      return this.mostAvailableApi
    }

    if (
      this.biketagConfig &&
      isBikeTagCredentials(this.biketagConfig) &&
      isBikeTagApiReady(this.biketagConfig)
    ) {
      return (this.mostAvailableApi = AvailableApis.biketag)
    } else if (this.imgurConfig && this.imgurClient) {
      return (this.mostAvailableApi = AvailableApis.imgur)
    } else if (this.sanityConfig && this.sanityClient) {
      return (this.mostAvailableApi = AvailableApis.sanity)
    } else if (this.redditConfig && this.redditClient) {
      return (this.mostAvailableApi = AvailableApis.reddit)
    } else if (this.twitterConfig && this.twitterClient) {
      return (this.mostAvailableApi = AvailableApis.twitter)
    }

    return undefined
  }

  private getPassthroughApiMethod(
    method: any,
    client:
      | RedditClient
      | ImgurClient
      | BikeTagClient
      | SanityClient
      | TwitterClient
  ): any {
    return (opts) => {
      return method(client, this.getDefaultOptions(opts))
    }
  }

  private getConfig(config?: BikeTagConfiguration): BikeTagConfiguration {
    return {
      biketag: config?.biketag ?? this.biketagConfig,
      sanity: config?.sanity ?? this.sanityConfig,
      imgur: config?.imgur ?? this.imgurConfig,
      reddit: config?.reddit ?? this.redditConfig,
      twitter: config?.twitter ?? this.twitterConfig,
    } as BikeTagConfiguration
  }

  private initializeClients(
    config?: BikeTagConfiguration
  ): BikeTagConfiguration {
    config = config ?? this.config()

    if (
      config.biketag &&
      isBikeTagCredentials(config.biketag) &&
      isBikeTagApiReady(config.biketag)
    ) {
      this.biketagClient = new Gun<BikeTagState>(config.biketag)
    }
    if (
      config.imgur &&
      isImgurCredentials(config.imgur) &&
      isImgurApiReady(config.imgur)
    ) {
      this.imgurClient = new ImgurClient(config.imgur)
    }
    if (
      config.sanity &&
      isSanityCredentials(config.sanity) &&
      isSanityApiReady(config.sanity)
    ) {
      this.sanityClient = sanityClient(config.sanity)
    }
    if (
      config.reddit &&
      isRedditCredentials(config.reddit) &&
      isRedditApiReady(config.reddit)
    ) {
      this.redditClient = new RedditClient(config.reddit)
    }
    if (
      config.twitter &&
      isTwitterCredentials(config.twitter) &&
      isTwitterApiReady(config.twitter)
    ) {
      this.twitterClient = new TwitterClient(config.twitter)
    }

    return config
  }

  config(
    config?: Credentials | BikeTagConfiguration | PartialBikeTagConfiguration,
    overwrite = true,
    reInitialize = false
  ): BikeTagConfiguration {
    if (config) {
      const parsedConfig = assignBikeTagConfiguration(
        config as BikeTagConfiguration
      )

      const initClientConfig = (
        type: AvailableApis,
        parsedConfig: BikeTagConfiguration,
        overwrite = true
      ) => {
        const configName = `${AvailableApis[type]}Config`
        const config = parsedConfig[AvailableApis[type]]
        let createCredentialsMethod: any = createBikeTagCredentials

        switch (type) {
          case AvailableApis.imgur:
            createCredentialsMethod = createImgurCredentials
            break
          case AvailableApis.reddit:
            createCredentialsMethod = createRedditCredentials
            break
          case AvailableApis.sanity:
            createCredentialsMethod = createSanityCredentials
            break
          case AvailableApis.twitter:
            createCredentialsMethod = createTwitterCredentials
            break
        }

        return !overwrite && this[configName] && config
          ? createCredentialsMethod(config, this[configName])
          : config ?? this[configName]
      }

      const biketagConfig = initClientConfig(
        AvailableApis.biketag,
        parsedConfig,
        overwrite
      )
      const imgurConfig = initClientConfig(
        AvailableApis.imgur,
        parsedConfig,
        overwrite
      )
      const sanityConfig = initClientConfig(
        AvailableApis.sanity,
        parsedConfig,
        overwrite
      )
      const redditConfig = initClientConfig(
        AvailableApis.reddit,
        parsedConfig,
        overwrite
      )
      const twitterConfig = initClientConfig(
        AvailableApis.twitter,
        parsedConfig,
        overwrite
      )

      if (reInitialize) {
        const initializeConfig: BikeTagConfiguration = {
          biketag: undefined,
          imgur: undefined,
          reddit: undefined,
          sanity: undefined,
          twitter: undefined,
        }

        if (!isEqual(this.imgurConfig, imgurConfig)) {
          initializeConfig.imgur = imgurConfig
        }
        if (!isEqual(this.redditConfig, redditConfig)) {
          initializeConfig.reddit = redditConfig
        }
        if (!isEqual(this.sanityConfig, sanityConfig)) {
          initializeConfig.sanity = sanityConfig
        }
        if (!isEqual(this.twitterConfig, twitterConfig)) {
          initializeConfig.twitter = twitterConfig
        }

        this.initializeClients(initializeConfig)
      }

      this.biketagConfig = biketagConfig
      this.imgurConfig = imgurConfig
      this.sanityConfig = sanityConfig
      this.redditConfig = redditConfig
      this.twitterConfig = twitterConfig
    }

    return this.getConfig()
  }

  plainRequest(options: AxiosRequestConfig = {}): Promise<AxiosResponse<any>> {
    return this.plainFetcher(options)
  }

  cachedRequest(options: AxiosRequestConfig = {}): Promise<AxiosResponse<any>> {
    return this.cachedFetcher(options)
  }

  request(options: AxiosRequestConfig = {}): Promise<AxiosResponse<string>> {
    return this.fetcher(options)
  }

  /// ****************************  Game Data Methods   ************************************ ///

  getGame(
    payload: RequireAtLeastOne<getGamePayload> | string | undefined
  ): Promise<BikeTagApiResponse<GameData>> {
    const onlyApplicableOpts =
      typeof payload === 'string' ? { game: payload } : payload
    const { client, options, api } = this.getDefaultAPI(
      onlyApplicableOpts,
      { source: AvailableApis[AvailableApis.sanity] },
      'game'
    )

    return api.getGame(client, options).catch((e) => {
      return {
        status: 500,
        data: null,
        error: e,
        success: false,
        source: AvailableApis[options.source],
      }
    })
  }

  /// ****************************  Tag Data Methods   ************************************ ///

  getTag(
    payload: RequireAtLeastOne<getTagPayload> | number,
    opts?: RequireAtLeastOne<Credentials>
  ): Promise<BikeTagApiResponse<Tag>> {
    const { client, options, api } = this.getDefaultAPI(payload, opts)
    let clientMethod = api.getTag

    switch (options.source) {
      case AvailableApis.reddit:
        clientMethod = clientMethod.bind({
          images: this.images({ ...this.imgurConfig, ...opts }),
        })
        break
    }

    return clientMethod(client, options).catch((e) => {
      return {
        status: 500,
        data: null,
        error: e,
        success: false,
        source: AvailableApis[options.source],
      }
    })
  }

  getTags(
    payload?: getTagsPayload | number[],
    opts?: RequireAtLeastOne<Credentials>
  ): Promise<BikeTagApiResponse<Tag[]>> {
    const { client, options, api } = this.getDefaultAPI(payload, opts)
    let clientMethod = api.getTags

    switch (options.source) {
      case AvailableApis.reddit:
        clientMethod = clientMethod.bind({
          images: this.images({ ...this.imgurConfig, ...opts }),
        })
        break
    }

    return clientMethod(client, options).catch((e) => {
      return {
        status: 500,
        data: null,
        error: e,
        success: false,
        source: AvailableApis[options.source],
      }
    })
  }

  updateTag(
    payload: updateTagPayload | updateTagPayload[],
    opts?: Credentials
  ): Promise<BikeTagApiResponse<boolean> | BikeTagApiResponse<boolean>[]> {
    const { client, options, api } = this.getDefaultAPI(payload, opts)
    let clientMethod = api.updateTag

    switch (options.source) {
      case AvailableApis.imgur:
        clientMethod = clientMethod.bind({
          getTag: this.getPassthroughApiMethod(api.getTag, client),
          uploadTagImage: this.getPassthroughApiMethod(
            api.uploadTagImage,
            client
          ),
        })
        break
    }

    return clientMethod(client, options).catch((e) => {
      return Promise.resolve({
        status: 500,
        data: null,
        error: e,
        success: false,
        source: AvailableApis[options.source],
      })
    })
  }

  uploadTagImage(
    payload: uploadTagImagePayload | uploadTagImagePayload[],
    opts?: Credentials
  ): Promise<BikeTagApiResponse<any | any[]>> {
    const { client, options, api } = this.getDefaultAPI(payload, opts)

    return api.uploadTagImage(client, options).catch((e) => {
      return Promise.resolve({
        status: 500,
        data: null,
        error: e,
        success: false,
        source: AvailableApis[options.source],
      })
    })
  }

  importTag(
    payload:
      | RequireAtLeastOne<importTagPayload>
      | RequireAtLeastOne<importTagPayload>[]
  ): Promise<BikeTagApiResponse<Tag[]>> {
    return payload as unknown as Promise<BikeTagApiResponse<Tag[]>>
  }

  deleteTag(
    payload: deleteTagPayload | number,
    opts?: RequireAtLeastOne<Credentials>
  ): Promise<BikeTagApiResponse<any>> {
    const { client, options, api } = this.getDefaultAPI(payload, opts)
    let clientMethod = api.deleteTag

    switch (options.source) {
      case AvailableApis.imgur:
        clientMethod = {
          getTag: this.getPassthroughApiMethod(api.getTag, client),
        }
        break
    }

    return clientMethod(client, options).catch((e) => {
      return Promise.resolve({
        status: 500,
        data: null,
        error: e,
        success: false,
        source: AvailableApis[options.source],
      })
    })
  }

  deleteTags(
    payload: deleteTagsPayload | number[],
    opts?: RequireAtLeastOne<Credentials>
  ): Promise<BikeTagApiResponse<any>> {
    const { client, options, api } = this.getDefaultAPI(payload, opts)
    let clientMethod = api.deleteTags

    switch (options.source) {
      case AvailableApis.imgur:
        clientMethod = clientMethod.bind({
          getTags: this.getPassthroughApiMethod(api.getTags, client),
        })
        break
    }

    return clientMethod(client, options).catch((e) => {
      return Promise.resolve({
        status: 500,
        data: null,
        error: e,
        success: false,
        source: AvailableApis[options.source],
      })
    })
  }

  /// ****************************  Player Data Methods   ************************************ ///

  getPlayer(): void {
    throw 'not implemented'
  }

  /// ****************************  Ambassador Data Methods   ******************************** ///

  getAmbassador(): void {
    throw 'not implemented'
  }

  /// ****************************  Setting Data Methods   *********************************** ///

  getSetting(): void {
    throw 'not implemented'
  }

  /// ****************************  Client Instance Methods   ************************************ ///

  /// Data provided by Gun Client
  data(opts: any = {}): BikTagGunClient {
    const options = opts ?? this.biketagConfig
    if (isBikeTagCredentials(options)) {
      return this.biketagClient
    }
  }

  /// Content powered by Sanity IO Client
  content(opts: any = {}): SanityClient {
    const options = opts ?? this.sanityConfig

    if (isSanityCredentials(options)) {
      return sanityClient(options)
    }

    throw new Error('options are invalid for creating a sanity client')
  }

  /// Images powered by Imgur Client
  images(opts: any = {}): ImgurClient {
    const options = opts ?? this.imgurConfig
    if (isImgurCredentials(options)) {
      return new ImgurClient(options)
    }

    throw new Error('options are invalid for creating an imgur client')
  }

  /// Discussions powered by RedditClient
  discussions(opts: any = {}): RedditClient {
    const options = opts ?? this.redditConfig
    if (isRedditCredentials(options)) {
      return new RedditClient(options)
    }

    throw new Error('options are invalid for creating an imgur client')
  }

  /// Mentions powered by TwitterClient
  mentions(opts: any = {}): TwitterClient {
    const options = opts ?? this.twitterConfig
    if (isTwitterCredentials(options)) {
      return new TwitterClient(options)
    }

    throw new Error('options are invalid for creating an twitter client')
  }

  /// Shares powered by InstagramClient
  // shares(options: any = {}): InstagramClient {
  //   if (isInstagramCredentials(options)) {
  //     return new InstagramClient(options)
  //   }

  //   throw new Error('options are invalid for creating an instagram client')
  // }
}

export type { BikeTagCredentials, BikeTagConfiguration }
