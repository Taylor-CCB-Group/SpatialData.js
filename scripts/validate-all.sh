#!/bin/bash

# Comprehensive dataset validation workflow
# This script runs all validation tests and generates a comparison report

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Output directory
OUTPUT_DIR="validation-results"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RUN_DIR="$OUTPUT_DIR/$TIMESTAMP"

echo -e "${BLUE}================================${NC}"
echo -e "${BLUE}Dataset Validation Workflow${NC}"
echo -e "${BLUE}================================${NC}"
echo ""

# Create output directory
mkdir -p "$RUN_DIR"
echo -e "${GREEN}Output directory: $RUN_DIR${NC}"
echo ""

# Step 1: Validate with Python (both versions)
echo -e "${YELLOW}Step 1/3: Validating with Python (v0.5.0 and v0.6.1)${NC}"
echo "This will test 10 datasets x 2 versions = 20 tests"
echo "Note: Most time is spent importing spatialdata, not downloading"
echo "Using parallel processing to speed things up..."
echo ""

uv run python/scripts/validate_datasets.py \
  --output-format json \
  --output-file "$RUN_DIR/python-results.json" > "$RUN_DIR/python-output.txt" 2>&1 || {
    echo -e "${RED}Python validation failed. Check $RUN_DIR/python-output.txt for details.${NC}"
    exit 1
}

# Also generate markdown for Python results
uv run python/scripts/validate_datasets.py \
  --output-format markdown \
  --output-file "$RUN_DIR/python-results.md" > /dev/null 2>&1

echo -e "${GREEN}✓ Python validation complete${NC}"
echo ""

# Step 2: Build the project if needed
if [ ! -d "packages/core/dist" ]; then
  echo -e "${YELLOW}Step 2/3: Building packages${NC}"
  echo "Building packages for JavaScript validation..."
  pnpm build > "$RUN_DIR/build-output.txt" 2>&1 || {
    echo -e "${RED}Build failed. Check $RUN_DIR/build-output.txt for details.${NC}"
    exit 1
  }
  echo -e "${GREEN}✓ Build complete${NC}"
  echo ""
else
  echo -e "${YELLOW}Step 2/3: Packages already built${NC}"
  echo -e "${GREEN}✓ Skipping build${NC}"
  echo ""
fi

# Step 3: Validate with JavaScript
echo -e "${YELLOW}Step 3/3: Validating with JavaScript${NC}"
echo "Testing datasets with JS implementation..."
echo ""

node scripts/validate-datasets-js.js \
  --output-format json \
  --output-file "$RUN_DIR/js-results.json" > "$RUN_DIR/js-output.txt" 2>&1 || {
    echo -e "${RED}JavaScript validation failed. Check $RUN_DIR/js-output.txt for details.${NC}"
    exit 1
}

# Generate comparison report
node scripts/validate-datasets-js.js \
  --compare-python "$RUN_DIR/python-results.json" \
  --output-format markdown \
  --output-file "$RUN_DIR/comparison-report.md" > /dev/null 2>&1

echo -e "${GREEN}✓ JavaScript validation complete${NC}"
echo ""

# Generate summary
echo -e "${BLUE}================================${NC}"
echo -e "${BLUE}Validation Summary${NC}"
echo -e "${BLUE}================================${NC}"
echo ""

# Count results from JSON files
PYTHON_SUCCESS=$(jq '[.[] | select(.success == true)] | length' "$RUN_DIR/python-results.json")
PYTHON_TOTAL=$(jq 'length' "$RUN_DIR/python-results.json")
JS_SUCCESS=$(jq '[.[] | select(.success == true)] | length' "$RUN_DIR/js-results.json")
JS_TOTAL=$(jq 'length' "$RUN_DIR/js-results.json")

echo -e "Python (both versions): ${GREEN}${PYTHON_SUCCESS}/${PYTHON_TOTAL}${NC} successful"
echo -e "JavaScript:             ${GREEN}${JS_SUCCESS}/${JS_TOTAL}${NC} successful"
echo ""

echo -e "${BLUE}Generated Reports:${NC}"
echo -e "  - Python results:       ${RUN_DIR}/python-results.md"
echo -e "  - JavaScript results:   ${RUN_DIR}/comparison-report.md"
echo -e "  - Raw JSON (Python):    ${RUN_DIR}/python-results.json"
echo -e "  - Raw JSON (JS):        ${RUN_DIR}/js-results.json"
echo ""

# Create a symlink to latest results
rm -f "$OUTPUT_DIR/latest"
ln -s "$TIMESTAMP" "$OUTPUT_DIR/latest"
echo -e "${GREEN}✓ Symlink created: $OUTPUT_DIR/latest${NC}"
echo ""

# Display a preview of failures
PYTHON_FAILURES=$(jq -r '.[] | select(.success == false) | "\(.dataset_name) (v\(.spatialdata_version)): \(.error_type)"' "$RUN_DIR/python-results.json" | head -5)
JS_FAILURES=$(jq -r '.[] | select(.success == false) | "\(.datasetName): \(.errorType)"' "$RUN_DIR/js-results.json" | head -5)

if [ -n "$PYTHON_FAILURES" ]; then
  echo -e "${RED}Python Failures (showing first 5):${NC}"
  echo "$PYTHON_FAILURES"
  echo ""
fi

if [ -n "$JS_FAILURES" ]; then
  echo -e "${RED}JavaScript Failures (showing first 5):${NC}"
  echo "$JS_FAILURES"
  echo ""
fi

echo -e "${GREEN}================================${NC}"
echo -e "${GREEN}Validation workflow complete!${NC}"
echo -e "${GREEN}================================${NC}"
echo ""
echo -e "View the comparison report:"
echo -e "  cat $RUN_DIR/comparison-report.md"
echo ""
echo -e "Or open in your markdown viewer:"
echo -e "  open $RUN_DIR/comparison-report.md"
