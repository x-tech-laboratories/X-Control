// Where drizzle-kit reads the devices schema and writes its migrations; `npm run db:generate` runs it for every feature.
export default { dialect: "sqlite", schema: "./src/shared/devices/schema.ts", out: "./src/shared/devices/migrations" };
