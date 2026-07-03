// Vitest global setup. Registers @testing-library/jest-dom matchers (toBeInTheDocument,
// toBeDisabled, etc.) on `expect`. Matchers only execute inside jsdom-environment tests
// (component specs opt in via a `// @vitest-environment jsdom` docblock); loading this in the
// default node environment is harmless — it only extends the matcher registry.
import '@testing-library/jest-dom/vitest'
