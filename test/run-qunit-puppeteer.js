/*
 * Headless QUnit runner for the jQuery test suite (headless Chrome via puppeteer).
 *
 * Runs on a modern Node (>= 18), separately from the project's own Node; puppeteer
 * is installed outside the repository tree and is never a dependency of the package.
 *
 * Usage:
 *   node test/run-qunit-puppeteer.js <url> [timeout-minutes]
 *
 * puppeteer is resolved from $QUNIT_RUNNER_DIR/node_modules when QUNIT_RUNNER_DIR is set,
 * otherwise through the normal module lookup (NODE_PATH etc.).
 *
 * Example (serve the repository root first, e.g. `php -S 127.0.0.1:8000 -t .`):
 *   QUNIT_RUNNER_DIR=$HOME/qunit-runner \
 *     node test/run-qunit-puppeteer.js http://127.0.0.1:8000/test/index.html
 *
 * How QUnit is hooked:
 *   test/index.html loads QUnit with a plain <script> tag and test/data/testinit.js
 *   sets QUnit.config.autostart = false; the suite is started later via QUnit.start()
 *   once all unit files are loaded through require.js. A script registered with
 *   page.evaluateOnNewDocument (runs in each new document before any page script)
 *   traps the `window.QUnit = QUnit` assignment done at the end of qunit.js with an
 *   Object.defineProperty setter and registers QUnit.begin / moduleStart / testStart /
 *   log / testDone / done callbacks right away, i.e. before any test can run. A short
 *   polling loop is a fallback in case the setter trap cannot be defined. Only the
 *   top-level window is hooked (iframe fixtures are ignored). Results are reported
 *   back through a function exposed with page.exposeFunction, so nothing in the test
 *   suite itself has to be modified.
 *
 * Output: one PASS/FAIL line per test (failed assertions are listed under FAIL
 * lines), followed by a summary line. Tests left out by the skip list in
 * test/data/testrunner.js (active only when navigator.webdriver is true) are announced
 * by "SKIPPED ..." console lines, echoed as "*** SKIPPED ..." and counted as skipped;
 * they do not affect the exit code. Exit code is 0 only if every test passed
 * (and at least one test ran); 1 otherwise (including global timeout, page crash
 * or load failure).
 */

"use strict";

const path = require( "path" );

function loadPuppeteer() {
	const dir = process.env.QUNIT_RUNNER_DIR;
	if ( dir ) {
		return require( path.join( dir, "node_modules", "puppeteer" ) );
	}
	return require( "puppeteer" );
}

const url = process.argv[ 2 ];
const timeoutMinutes = process.argv[ 3 ] ? parseFloat( process.argv[ 3 ] ) : 20;
const startTime = Date.now();

let browser = null;
let finished = false;
let begun = false;
let currentModule = null;
let currentTest = null;
let pendingFailures = [];
const failedTests = [];
const skippedTests = [];
const stats = {
	tests: 0,
	testsPassed: 0,
	testsFailed: 0,
	assertions: 0,
	assertionsPassed: 0,
	assertionsFailed: 0
};

function out( line ) {
	process.stdout.write( line + "\n" );
}

function firstLine( text ) {
	if ( text === undefined || text === null ) {
		return "";
	}
	return String( text ).replace( /^\s+/, "" ).split( /\r?\n/ )[ 0 ];
}

function indent( text, prefix ) {
	return String( text ).split( /\r?\n/ ).join( "\n" + prefix );
}

function testLabel( module, name ) {
	return ( module || "(no module)" ) + " :: " + name;
}

async function exitWith( code ) {
	if ( finished ) {
		return;
	}
	finished = true;
	try {
		if ( browser ) {
			await Promise.race( [
				browser.close(),
				new Promise( ( resolve ) => setTimeout( resolve, 10000 ) )
			] );
		}
	} catch ( e ) {
		out( "[runner] warning: failed to close browser: " + e );
	}
	process.exit( code );
}

function printSummary( runtime ) {
	out( "" );
	if ( failedTests.length ) {
		out( "Failed tests:" );
		for ( const label of failedTests ) {
			out( "  - " + label );
		}
		out( "" );
	}
	if ( skippedTests.length ) {
		out( "Skipped tests (not run; skip list in test/data/testrunner.js):" );
		for ( const label of skippedTests ) {
			out( "  - " + label );
		}
		out( "" );
	}
	out( "Tests: " + stats.tests + " total, " + stats.testsPassed + " passed, " +
		stats.testsFailed + " failed, " + skippedTests.length + " skipped; Assertions: " +
		stats.assertions + " total, " +
		stats.assertionsPassed + " passed, " + stats.assertionsFailed + " failed; Time: " +
		runtime + "ms" );
}

function handleMessage( msg ) {
	if ( finished || !msg || typeof msg !== "object" ) {
		return;
	}

	switch ( msg.type ) {
	case "hooked":
		out( "[runner] QUnit hooked via " + msg.via );
		break;

	case "begin":
		// QUnit 1.14 may fire "begin" more than once (load + start); report it once
		if ( !begun ) {
			begun = true;
			out( "[runner] QUnit run started" );
		}
		break;

	case "moduleStart":
		currentModule = msg.name;
		out( "" );
		out( "Module: " + msg.name );
		break;

	case "testStart":
		currentTest = testLabel( msg.module, msg.name );
		pendingFailures = [];
		break;

	case "log":
		pendingFailures.push( msg );
		break;

	case "testDone": {
		const label = testLabel( msg.module, msg.name );
		const ok = msg.failed === 0;
		stats.tests++;
		stats.assertions += msg.total;
		stats.assertionsPassed += msg.passed;
		stats.assertionsFailed += msg.failed;
		if ( ok ) {
			stats.testsPassed++;
		} else {
			stats.testsFailed++;
			failedTests.push( label );
		}
		out( ( ok ? "PASS " : "FAIL " ) + label + " (" + msg.passed + "/" + msg.total +
			" assertions)" );
		if ( !ok ) {
			for ( const f of pendingFailures ) {
				out( "    - message: " + indent( f.message || "(no message)", "      " ) );
				if ( f.hasExpected ) {
					out( "      expected: " + indent( f.expected, "      " ) );
					out( "      actual:   " + indent( f.actual, "      " ) );
				}
				if ( f.source ) {
					out( "      source: " + firstLine( f.source ) );
				}
			}
		}
		pendingFailures = [];
		currentTest = null;
		break;
	}

	case "done": {
		const runtime = typeof msg.runtime === "number" ? msg.runtime : Date.now() - startTime;
		printSummary( runtime );
		if ( stats.tests === 0 ) {
			out( "[runner] ERROR: no tests were run" );
			exitWith( 1 );
		} else if ( stats.testsFailed > 0 || msg.failed > 0 ) {
			exitWith( 1 );
		} else {
			exitWith( 0 );
		}
		break;
	}
	}
}

// Runs inside the page (serialized by evaluateOnNewDocument) -- must be self-contained
function installQUnitHook() {
	if ( window !== window.top || window.__qunitHookInstalled ) {
		return;
	}
	window.__qunitHookInstalled = true;

	var hooked = false,
		stored,
		poller,
		queue = [];

	function send( msg ) {
		queue.push( JSON.stringify( msg ) );
		if ( typeof window.__qunitRunnerReport === "function" ) {
			while ( queue.length ) {
				window.__qunitRunnerReport( queue.shift() );
			}
		}
	}

	function dump( value ) {
		try {
			var Q = window.QUnit,
				text = Q && Q.jsDump ? Q.jsDump.parse( value ) : String( value );
			text = String( text );
			return text.length > 2000 ? text.slice( 0, 2000 ) + " ...(truncated)" : text;
		} catch ( e ) {
			return "[unserializable: " + e + "]";
		}
	}

	function hook( Q, via ) {
		if ( hooked || !Q || typeof Q.log !== "function" || typeof Q.done !== "function" ) {
			return;
		}
		hooked = true;
		if ( poller ) {
			clearInterval( poller );
		}

		Q.begin(function() {
			send({ type: "begin" });
		});
		Q.moduleStart(function( d ) {
			send({ type: "moduleStart", name: String( d.name ) });
		});
		Q.testStart(function( d ) {
			send({ type: "testStart", module: String( d.module ), name: String( d.name ) });
		});
		Q.log(function( d ) {
			if ( d.result ) {
				return;
			}
			var hasExpected = Object.prototype.hasOwnProperty.call( d, "expected" );
			send({
				type: "log",
				message: d.message === undefined ? "" : String( d.message ),
				hasExpected: hasExpected,
				expected: hasExpected ? dump( d.expected ) : "",
				actual: hasExpected ? dump( d.actual ) : "",
				source: d.source ? String( d.source ) : ""
			});
		});
		Q.testDone(function( d ) {
			send({
				type: "testDone",
				module: String( d.module ),
				name: String( d.name ),
				failed: d.failed,
				passed: d.passed,
				total: d.total,
				runtime: d.runtime
			});
		});
		Q.done(function( d ) {
			send({
				type: "done",
				failed: d.failed,
				passed: d.passed,
				total: d.total,
				runtime: d.runtime
			});
		});
		send({ type: "hooked", via: via });
	}

	// Primary: trap the `window.QUnit = QUnit` assignment at the end of qunit.js
	try {
		Object.defineProperty( window, "QUnit", {
			configurable: true,
			enumerable: true,
			get: function() {
				return stored;
			},
			set: function( value ) {
				stored = value;
				hook( value, "setter trap" );
			}
		});
	} catch ( e ) {}

	// Fallback: poll (QUnit.config.autostart is false, so tests start well after load)
	poller = setInterval(function() {
		if ( hooked ) {
			clearInterval( poller );
		} else if ( window.QUnit ) {
			hook( window.QUnit, "polling" );
		}
	}, 5 );
}

async function main() {
	if ( !url ) {
		out( "Usage: node test/run-qunit-puppeteer.js <url> [timeout-minutes]" );
		process.exit( 2 );
	}

	const puppeteer = loadPuppeteer();

	setTimeout( () => {
		if ( finished ) {
			return;
		}
		out( "" );
		out( "[runner] TIMEOUT: global timeout of " + timeoutMinutes + " minute(s) reached" );
		out( "[runner] test running at timeout: " + ( currentTest || "(none)" ) +
			"; current module: " + ( currentModule || "(none)" ) );
		printSummary( Date.now() - startTime );
		exitWith( 1 );
	}, timeoutMinutes * 60 * 1000 );

	browser = await puppeteer.launch( {
		headless: true,
		args: [
			"--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",

			// Modern Chrome is phasing out the `unload` event (blocked by permissions
			// policy here); the 2014-era suite relies on it, e.g. data #10080 listens
			// for an iframe's unload. Re-enable it as the browsers of that era had it.
			"--disable-features=DeprecateUnload,DeprecateUnloadByAllowList"
		],
		defaultViewport: { width: 1280, height: 1024 }
	} );
	out( "[runner] Browser: " + await browser.version() );

	browser.on( "disconnected", () => {
		if ( !finished ) {
			out( "[runner] ERROR: browser disconnected unexpectedly" );
			printSummary( Date.now() - startTime );
			exitWith( 1 );
		}
	} );

	const page = await browser.newPage();
	out( "[runner] User agent: " + await browser.userAgent() );

	await page.exposeFunction( "__qunitRunnerReport", ( json ) => {
		let msg;
		try {
			msg = JSON.parse( json );
		} catch ( e ) {
			out( "[runner] warning: bad message from page: " + e );
			return;
		}
		handleMessage( msg );
	} );
	await page.evaluateOnNewDocument( installQUnitHook );

	page.on( "console", ( msg ) => {
		// "verbose" entries are DevTools lint hints (e.g. missing autocomplete attributes)
		if ( msg.type() === "verbose" ) {
			return;
		}
		const text = msg.text();

		// Tests deliberately not registered by the skip list in test/data/testrunner.js
		if ( /^SKIPPED /.test( text ) ) {
			skippedTests.push( text.slice( "SKIPPED ".length ) );
			out( "*** " + text );
			return;
		}
		const loc = msg.location && msg.location();
		out( "[page] console." + msg.type() + ": " + text +
			( loc && loc.url ? " (" + loc.url + ":" + loc.lineNumber + ")" : "" ) );
	} );
	page.on( "pageerror", ( err ) => {
		out( "[page] error: " + ( err && err.stack ? err.stack : err ) );
	} );
	page.on( "error", ( err ) => {
		// Page crash
		out( "[runner] ERROR: page crashed: " + err );
		printSummary( Date.now() - startTime );
		exitWith( 1 );
	} );
	page.on( "requestfailed", ( req ) => {
		const failure = req.failure();
		const text = failure ? failure.errorText : "unknown";

		// Aborted requests are expected (xhr.abort() in the ajax tests, removed iframes);
		// HTTP 4xx/5xx are responses, not failures, so they never show up here.
		if ( text !== "net::ERR_ABORTED" ) {
			out( "[page] request failed: " + req.method() + " " + req.url() + " -> " + text );
		}
	} );

	out( "[runner] Opening " + url );
	try {
		const response = await page.goto( url, { waitUntil: "load", timeout: 120000 } );
		if ( !response || !response.ok() ) {
			out( "[runner] ERROR: unable to load " + url + " (status: " +
				( response ? response.status() : "no response" ) + ")" );
			await exitWith( 1 );
		}
	} catch ( e ) {
		out( "[runner] ERROR: unable to load " + url + ": " + e.message );
		await exitWith( 1 );
	}
}

main().catch( ( e ) => {
	out( "[runner] ERROR: " + ( e && e.stack ? e.stack : e ) );
	exitWith( 1 );
} );
