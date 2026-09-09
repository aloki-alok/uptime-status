const colocated = new Set<string>();

for (const pattern of ["apps/**/src/**/*.test.ts", "packages/**/src/**/*.test.ts"]) {
  const glob = new Bun.Glob(pattern);
  for await (const path of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
    colocated.add(path);
  }
}

if (colocated.size > 0) {
  throw new Error(
    `Move tests out of production source directories:\n${[...colocated].sort().join("\n")}`,
  );
}

console.log("Test layout verified");
