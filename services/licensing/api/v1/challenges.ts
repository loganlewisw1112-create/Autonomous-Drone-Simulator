import type { VercelRequest, VercelResponse } from '@vercel/node'
import { handleRoute } from '../../src/http.js'

export default (request: VercelRequest, response: VercelResponse) =>
  handleRoute('challenge', request, response)
