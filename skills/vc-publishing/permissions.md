bashWhitelist: ["pnpm exec tsx skills/vc-publishing/scripts/publish.ts", "pnpm exec tsx skills/vc-publishing/scripts/health-check.ts"]
requiredSdkTools: [Bash]
maxStepsPerInvocation: 20
requiresApproval: [{action: publish, via: telegram}]
healthCheck:
  script: scripts/health-check.ts
  schedule: "0 7 * * *"
