/**
 * Tool metadata (name/title/description/inputSchema) for the two backend
 * tools that back the App Objects (CAS) and App Database demo tabs — split
 * out of `mcp-message-handlers.ts` so that already-large file only gains a
 * couple of dispatch lines. See `app-objects-demo-tool.ts` and
 * `app-db-demo-tool.ts` for the handlers, and `app-platform-tool-call.ts` for
 * the shared bot-credential transport. Step-1 generic platform contract,
 * merged hub `bff01ee8`, live only on tenant.132+.
 */
export const APP_OBJECT_STORE_TOOL = 'hr_app_object_store';
export const APP_DB_STORE_TOOL = 'hr_app_db_store';

export const APP_PLATFORM_TOOL_DEFINITIONS = [
	{
		name: APP_OBJECT_STORE_TOOL,
		title: 'App Objects (CAS) demo',
		description:
			'Store/read one immutable, room-private, content-addressed object via mcpapp.objects.put/head/get, ' +
			'authenticated with this app\'s own installation-bot credential. Live only once this room\'s Hub is on ' +
			'tenant.132+.',
		inputSchema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['put', 'head', 'get'] },
				roomId: { type: 'string', description: "Optional; must equal the room this call is made from (defaults to it)." },
				dataBase64: { type: 'string' },
				mediaType: { type: 'string' },
				digest: { type: 'string' },
			},
			required: ['action'],
		},
	},
	{
		name: APP_DB_STORE_TOOL,
		title: 'App Database demo',
		description:
			'Register a demo collection, create/query records, and read its schema via mcpapp.db.registerCollection / ' +
			'create / query / getSchema, authenticated with this app\'s own installation-bot credential. Live only ' +
			'once this room\'s Hub is on tenant.132+.',
		inputSchema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['registerCollection', 'create', 'query', 'getSchema'] },
				roomId: { type: 'string', description: "Optional; must equal the room this call is made from (defaults to it)." },
				label: { type: 'string' },
				note: { type: 'string' },
			},
			required: ['action'],
		},
	},
] as const;
