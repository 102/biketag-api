import { SanityClient } from '@sanity/client'
import { deleteTagPayload } from '../common/payloads'
import { BikeTagApiResponse } from '../common/types'

export async function deleteTag(
  client: SanityClient,
  payload: deleteTagPayload
): Promise<BikeTagApiResponse<any>> {
  if (!payload.slug?.length) {
    if (payload.tagnumber) {
      payload.slug = `${payload.game}-tag-${payload.tagnumber}`
    } else {
      return {
        data: null,
        success: false,
        status: 0,
        source: 'sanity',
      }
    }
  }
  const query = `*[_type == "tag" && _id == ${payload.slug}]`

  return client.delete({ query }).then((result) => {
    return {
      data: result,
      success: true,
      status: 1,
      source: 'sanity',
    }
  })
}
