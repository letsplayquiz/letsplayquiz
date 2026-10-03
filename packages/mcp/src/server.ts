import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { KINDS, LANGS } from 'letsplayquiz/lib'
import { getGuide, validateQuiz, publishQuiz, listMyQuizzes, type ToolContext } from './tools.js'

const lang = z.enum(LANGS).optional().describe('Language of the quiz and of server messages (ko, ja or en)')
const quiz = z
  .record(z.string(), z.unknown())
  .describe('The quiz definition object. Call get_guide first to learn the schema for the chosen kind.')

export function createServer(ctx: ToolContext, version: string): McpServer {
  const server = new McpServer({ name: 'letsplayquiz', version })

  server.registerTool(
    'get_guide',
    {
      title: 'Get quiz authoring guide',
      description:
        'Fetch the LetsPlayQuiz authoring guide as JSON: the quiz schema and rules for each kind (score, type, balance, worldcup). Call this before writing a quiz.',
      inputSchema: {
        kind: z.enum(KINDS).optional().describe('Quiz kind to get the guide for; omit for the overview'),
        lang,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => getGuide(ctx, args),
  )

  server.registerTool(
    'validate_quiz',
    {
      title: 'Validate a quiz',
      description:
        'Validate a quiz definition against the LetsPlayQuiz rules without publishing. Returns ok, blockers (must fix) and warnings. A failed validation is a normal result, not an error.',
      inputSchema: { quiz, lang },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => validateQuiz(ctx, args),
  )

  server.registerTool(
    'publish_quiz',
    {
      title: 'Publish a quiz',
      description:
        'Publishes a PUBLIC quiz on letsplayquiz.net that anyone can open. Confirm with the user before calling this. Validate first. Returns the public url and an ownerUrl; the ownerUrl is the only proof of ownership and cannot be reissued, so show it to the user and keep it private. If the result says the quiz MAY have been published, do not retry — ask the user.',
      inputSchema: {
        quiz,
        lang,
        save: z
          .boolean()
          .default(true)
          .describe('Save the url and ownerUrl to the local history file shared with the CLI (default true)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => publishQuiz(ctx, args),
  )

  server.registerTool(
    'list_my_quizzes',
    {
      title: 'List my published quizzes',
      description:
        'List quizzes published from this machine (local history shared with the letsplayquiz CLI). Makes no server call. Includes each ownerUrl, which is the user\'s own private data.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => listMyQuizzes(ctx),
  )

  return server
}
