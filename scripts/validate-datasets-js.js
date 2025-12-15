#!/usr/bin/env node
/**
 * Validate spatialdata dataset compatibility with the JavaScript implementation.
 *
 * This script tests loading publicly available spatialdata datasets using the
 * @spatialdata/core library in a Node.js environment (outside the browser).
 */

import { readZarr } from '../packages/core/dist/index.js';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Dataset definitions from https://spatialdata.scverse.org/en/stable/tutorials/notebooks/datasets/README.html
const DATASETS = [
  {
    name: "Visium HD (Mouse intestin)",
    url: "https://s3.embl.de/spatialdata/spatialdata-sandbox/visium_hd_3.0.0_io.zarr/",
  },
  {
    name: "Visium (Breast cancer)",
    url: "https://s3.embl.de/spatialdata/spatialdata-sandbox/visium_associated_xenium_io.zarr/",
  },
  {
    name: "Xenium (Breast cancer - Rep1)",
    url: "https://s3.embl.de/spatialdata/spatialdata-sandbox/xenium_rep1_io.zarr/",
  },
  {
    name: "Xenium (Breast cancer - Rep2)",
    url: "https://s3.embl.de/spatialdata/spatialdata-sandbox/xenium_rep2_io.zarr/",
  },
  {
    name: "CyCIF (Lung adenocarcinoma)",
    url: "https://s3.embl.de/spatialdata/spatialdata-sandbox/mcmicro_io.zarr/",
  },
  {
    name: "MERFISH (Mouse brain)",
    url: "https://s3.embl.de/spatialdata/spatialdata-sandbox/merfish.zarr/",
  },
  {
    name: "MIBI-TOF (Colorectal carcinoma)",
    url: "https://s3.embl.de/spatialdata/spatialdata-sandbox/mibitof.zarr/",
  },
  {
    name: "Imaging Mass Cytometry (Multiple cancers)",
    url: "https://s3.embl.de/spatialdata/spatialdata-sandbox/steinbock_io.zarr/",
  },
  {
    name: "Molecular Cartography (Mouse Liver)",
    url: "https://s3.embl.de/spatialdata/spatialdata-sandbox/mouse_liver.zarr",
  },
  {
    name: "SpaceM (Hepa/NIH3T3 cells)",
    url: "https://s3.embl.de/spatialdata/spatialdata-sandbox/spacem_helanih3t3.zarr",
  },
];

/**
 * Validate a single dataset
 */
async function validateDataset(dataset, useProxy = false) {
  const result = {
    datasetName: dataset.name,
    datasetUrl: dataset.url,
    implementation: 'JavaScript (@spatialdata/core)',
    success: false,
    errorType: null,
    errorMessage: null,
    elements: null,
    coordinateSystems: null,
  };

  try {
    // Use proxy if requested
    const url = useProxy
      ? `http://localhost:8081/?url=${encodeURIComponent(dataset.url)}`
      : dataset.url;

    // Try to read the dataset
    const sdata = await readZarr(url);

    // Extract basic info
    const elements = {};
    for (const elementType of ['images', 'labels', 'points', 'shapes', 'tables']) {
      if (sdata[elementType]) {
        elements[elementType] = Object.keys(sdata[elementType]);
      }
    }

    // Get coordinate systems
    let coordinateSystems = null;
    if (sdata.coordinateSystems) {
      if (Array.isArray(sdata.coordinateSystems)) {
        coordinateSystems = sdata.coordinateSystems;
      } else {
        coordinateSystems = [sdata.coordinateSystems];
      }
    }

    result.success = true;
    result.elements = elements;
    result.coordinateSystems = coordinateSystems;
  } catch (error) {
    result.success = false;
    result.errorType = error.constructor.name;
    result.errorMessage = error.message;

    // Include stack trace for debugging
    if (error.stack) {
      result.stackTrace = error.stack.split('\n').slice(0, 5).join('\n');
    }
  }

  return result;
}

/**
 * Generate a markdown table from validation results
 */
function generateMarkdownTable(results, pythonResults = null) {
  const lines = [];

  lines.push('# SpatialData Dataset Compatibility Report (JavaScript)');
  lines.push(`\nGenerated: ${new Date().toISOString()}\n`);
  lines.push('## Summary');
  lines.push('');

  // If we have Python results, show comparison
  if (pythonResults) {
    lines.push('| Dataset | JS | Python v0.5.0 | Python v0.6.1 | URL |');
    lines.push('|---------|-------|---------------|---------------|-----|');

    const pythonResultsByDataset = {};
    for (const r of pythonResults) {
      if (!pythonResultsByDataset[r.dataset_name]) {
        pythonResultsByDataset[r.dataset_name] = {};
      }
      pythonResultsByDataset[r.dataset_name][r.spatialdata_version] = r;
    }

    for (const result of results) {
      const jsStatus = result.success ? '✅' : '❌';
      const py050 = pythonResultsByDataset[result.datasetName]?.['0.5.0'];
      const py061 = pythonResultsByDataset[result.datasetName]?.['0.6.1'];
      const py050Status = py050 ? (py050.success ? '✅' : '❌') : '⏭️';
      const py061Status = py061 ? (py061.success ? '✅' : '❌') : '⏭️';

      const urlShort = result.datasetUrl.split('spatialdata-sandbox/')[1] || result.datasetUrl;
      lines.push(`| ${result.datasetName} | ${jsStatus} | ${py050Status} | ${py061Status} | \`${urlShort}\` |`);
    }
  } else {
    lines.push('| Dataset | Status | URL |');
    lines.push('|---------|--------|-----|');

    for (const result of results) {
      const status = result.success ? '✅' : '❌';
      const urlShort = result.datasetUrl.split('spatialdata-sandbox/')[1] || result.datasetUrl;
      lines.push(`| ${result.datasetName} | ${status} | \`${urlShort}\` |`);
    }
  }

  lines.push('');
  lines.push('Legend: ✅ Success | ❌ Failed | ⏭️ Not tested');
  lines.push('');

  // Add detailed error information
  lines.push('## Detailed Results (JavaScript)');
  lines.push('');

  for (const result of results) {
    lines.push(`### ${result.datasetName}`);
    lines.push('');

    if (result.success) {
      lines.push('**Status:** ✅ Success');
      lines.push('');

      if (result.elements && Object.keys(result.elements).length > 0) {
        lines.push('**Elements:**');
        for (const [elementType, items] of Object.entries(result.elements)) {
          if (Array.isArray(items) && items.length > 0) {
            lines.push(`- ${elementType}: ${items.join(', ')}`);
          } else {
            lines.push(`- ${elementType}: present`);
          }
        }
        lines.push('');
      }

      if (result.coordinateSystems && result.coordinateSystems.length > 0) {
        lines.push(`**Coordinate Systems:** ${result.coordinateSystems.join(', ')}`);
        lines.push('');
      }
    } else {
      lines.push('**Status:** ❌ Failed');
      lines.push('');
      lines.push(`**Error Type:** \`${result.errorType}\``);
      lines.push('');
      lines.push('**Error Message:**');
      lines.push('```');
      lines.push(result.errorMessage || 'No error message');
      lines.push('```');
      lines.push('');

      if (result.stackTrace) {
        lines.push('**Stack Trace:**');
        lines.push('```');
        lines.push(result.stackTrace);
        lines.push('```');
        lines.push('');
      }
    }

    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = {
    dataset: null,
    outputFormat: 'markdown',
    outputFile: null,
    useProxy: false,
    comparePython: null,
  };

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];

    if (arg === '--dataset' && i + 1 < process.argv.length) {
      args.dataset = process.argv[++i];
    } else if (arg === '--output-format' && i + 1 < process.argv.length) {
      args.outputFormat = process.argv[++i];
    } else if (arg === '--output-file' && i + 1 < process.argv.length) {
      args.outputFile = process.argv[++i];
    } else if (arg === '--use-proxy') {
      args.useProxy = true;
    } else if (arg === '--compare-python' && i + 1 < process.argv.length) {
      args.comparePython = process.argv[++i];
    } else if (arg === '--help') {
      console.log(`
Usage: node validate-datasets-js.js [options]

Options:
  --dataset <name>           Test only dataset matching this name
  --output-format <format>   Output format: markdown, csv, json (default: markdown)
  --output-file <path>       Write output to file instead of stdout
  --use-proxy                Use CORS proxy (http://localhost:8081)
  --compare-python <file>    Compare with Python results JSON file
  --help                     Show this help message
      `);
      process.exit(0);
    }
  }

  return args;
}

/**
 * Main function
 */
async function main() {
  const args = parseArgs();

  // Filter datasets if specific one requested
  let datasets = DATASETS;
  if (args.dataset) {
    datasets = DATASETS.filter(d =>
      d.name.toLowerCase().includes(args.dataset.toLowerCase())
    );

    if (datasets.length === 0) {
      console.error(`Error: No dataset matching '${args.dataset}' found`);
      console.error('\nAvailable datasets:');
      for (const d of DATASETS) {
        console.error(`  - ${d.name}`);
      }
      process.exit(1);
    }
  }

  // Warn if using proxy
  if (args.useProxy) {
    console.error('Using CORS proxy at http://localhost:8081');
    console.error('Make sure the proxy is running: pnpm test:proxy');
    console.error('');
  }

  // Run validation
  console.error(`Validating ${datasets.length} dataset(s) with JavaScript implementation...\n`);

  const results = [];
  let current = 0;

  for (const dataset of datasets) {
    current++;
    console.error(`[${current}/${datasets.length}] Testing ${dataset.name}...`);

    const result = await validateDataset(dataset, args.useProxy);
    results.push(result);

    const status = result.success ? '✅' : '❌';
    console.error(`        ${status} ${dataset.name}`);
    if (!result.success) {
      console.error(`           Error: ${result.errorType}`);
    }
  }

  console.error('\nValidation complete!\n');

  // Load Python results if requested
  let pythonResults = null;
  if (args.comparePython) {
    try {
      const fs = await import('node:fs');
      const data = fs.readFileSync(args.comparePython, 'utf-8');
      pythonResults = JSON.parse(data);
      console.error(`Loaded Python results from ${args.comparePython}\n`);
    } catch (error) {
      console.error(`Warning: Could not load Python results: ${error.message}`);
    }
  }

  // Generate output
  let output;
  if (args.outputFormat === 'markdown') {
    output = generateMarkdownTable(results, pythonResults);
  } else if (args.outputFormat === 'csv') {
    // Simple CSV generation
    const lines = ['Dataset Name,Dataset URL,Implementation,Success,Error Type,Error Message,Elements,Coordinate Systems'];
    for (const r of results) {
      const elements = r.elements ? JSON.stringify(r.elements).replace(/"/g, '""') : '';
      const cs = r.coordinateSystems ? JSON.stringify(r.coordinateSystems).replace(/"/g, '""') : '';
      const errorMsg = (r.errorMessage || '').replace(/"/g, '""');
      lines.push(`"${r.datasetName}","${r.datasetUrl}","${r.implementation}",${r.success},"${r.errorType || ''}","${errorMsg}","${elements}","${cs}"`);
    }
    output = lines.join('\n');
  } else if (args.outputFormat === 'json') {
    output = JSON.stringify(results, null, 2);
  } else {
    console.error(`Unknown output format: ${args.outputFormat}`);
    process.exit(1);
  }

  // Write output
  if (args.outputFile) {
    writeFileSync(resolve(args.outputFile), output);
    console.error(`Results written to: ${args.outputFile}`);
  } else {
    console.log(output);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
