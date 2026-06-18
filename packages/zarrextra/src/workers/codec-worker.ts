// Registration must run before fizarrita's codec-worker installs message handlers.
// Use ordered static imports (not top-level await) so the worker is synchronously
// ready when the browser marks the script as loaded.
import './codec-worker-init';
import '@fideus-labs/fizarrita/codec-worker';
