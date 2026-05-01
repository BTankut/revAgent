# System Classification

## Duct systems

`LookupParameter("System Classification")` typical values:

- `Supply Air`
- `Return Air`
- `Exhaust Air`
- `Other Air`

Other useful lookups:

- `LookupParameter("System Type")` — project-specific system type
- `LookupParameter("System Name")` — system instance name

## Pipe systems

`LookupParameter("System Type").AsValueString()` typical values:

- `Domestic Cold Water`
- `Domestic Hot Water`
- `Sanitary`
- `Storm`
- `Fire Protection`
- `Hydronic Supply`
- `Hydronic Return`
