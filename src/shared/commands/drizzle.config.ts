// Where drizzle-kit reads the commands schema and writes its migrations; `npm run db:generate` runs it for every feature.
export default { dialect: "sqlite", schema: "./src/shared/commands/schema.ts", out: "./src/shared/commands/migrations" };
