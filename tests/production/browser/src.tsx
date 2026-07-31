import { createRoot } from 'react-dom/client';
import { LabelsColorByConsumer } from './labelsColorByScenario';
import { PolygonFixtureConsumer } from './polygonShapesScenario';

/**
 * One built bundle, several scenarios, selected by query string.
 *
 * Not one HTML entry per scenario: the build keeps code splitting off to dodge a
 * Rolldown panic in apache-arrow's iterator re-export, and multiple entries into
 * a single chunk is exactly the case that turns back on.
 */
const scenarios = {
  'polygon-shapes': PolygonFixtureConsumer,
  'labels-color-by': LabelsColorByConsumer,
} as const;

type ScenarioName = keyof typeof scenarios;

function isScenarioName(value: string | null): value is ScenarioName {
  return value !== null && value in scenarios;
}

const requested = new URLSearchParams(window.location.search).get('scenario');
const Scenario = isScenarioName(requested) ? scenarios[requested] : PolygonFixtureConsumer;

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Production browser consumer root element is missing');
}
createRoot(rootElement).render(<Scenario />);
