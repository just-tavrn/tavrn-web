// SPDX-License-Identifier: Apache-2.0
//! Address first (docs/DESKTOP.md "Signing in"): the node of an identity domain (`alice@home.example` →
//! `home.example`), found as FEDERATION.md §1.4 says. The shell does it because a browser cannot query DNS and the app
//! has no node to ask before its first sign-in:
//!
//! 1. `https://<domain>/.well-known/tavrn`, validated: `tavrn` = 1, `domain` equal to the requested one, the endpoints
//!    https/wss without credentials, query or fragment, `api` ending in `/api/v1`. Delegation (endpoints on another
//!    host) is the normal case; the result keeps the identity domain and the endpoints.
//! 2. After a `404` or without an HTTPS server (refused, DNS, TLS, timeout): the `_tavrn._tcp.<domain>` SRV records
//!    (lowest priority first, then highest weight, at most 3, domain names only). The request goes to the target's host
//!    and port but is made for the identity domain: SNI and `Host` name the domain and the target's certificate must be
//!    valid for the domain (FEDERATION.md §1.4), so a forged DNS answer alone cannot hand the app another node. The
//!    target's document must name `domain`.
//! 3. After a `404` only: `https://<domain>/api/v1`, the last attempt (it must answer `GET /node`).
//!
//! Any other status, an invalid document or a refused redirect is an error at its step. A development node on this
//! computer (`localhost:<port>`, `127.0.0.1:<port>`) is asked over plain http, without SRV.

use std::future::Future;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::Url;

/// SRV targets tried at most.
pub const MAX_SRV_TARGETS: usize = 3;
/// Cap of a discovery document (FEDERATION.md §1.3 rule 5).
pub const MAX_DOCUMENT: usize = 64 * 1024;
/// Hosts reached over plain http: a node in development mode on this computer (as `node_url.rs`).
const DEV_HOSTS: [&str; 2] = ["localhost", "127.0.0.1"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    WellKnown,
    Srv,
    Domain,
}

/// The node found for an identity domain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Resolved {
    /// Identity domain (addresses).
    pub domain: String,
    /// API endpoint (`…/api/v1`), WebSocket and the web client's origin; possibly on another host than `domain`.
    pub api: String,
    pub ws: String,
    pub web: String,
    pub source: Source,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Step {
    Input,
    WellKnown,
    Srv,
    Direct,
}

/// Why no node was found: the code the client translates (`resolve.*`) and the step that failed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Failure {
    pub code: &'static str,
    pub step: Step,
    pub domain: String,
}

impl Failure {
    pub fn new(code: &'static str, step: Step, domain: &str) -> Self {
        Self { code, step, domain: domain.to_string() }
    }
}

pub const NOT_FOUND: &str = "resolve.not_found";
pub const INVALID: &str = "resolve.invalid";
pub const UNREACHABLE: &str = "resolve.unreachable";
pub const DOMAIN_INVALID: &str = "resolve.domain_invalid";

/// An HTTP answer (status and at most [`MAX_DOCUMENT`] bytes of body).
#[derive(Debug, Clone)]
pub struct Fetched {
    pub status: u16,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchError {
    /// No HTTP answer: DNS failure, connection refused or reset, TLS failure, timeout.
    Transport,
    /// An answer, but not a usable one: a refused redirect, a body over the cap.
    Refused,
}

pub trait Fetcher {
    fn get(&self, url: &str) -> impl Future<Output = Result<Fetched, FetchError>> + Send;
    /// GET `url` (on the identity domain) over a connection to `host:port` instead of the URL's host: SNI and `Host` are
    /// the URL's host and the certificate must be valid for it. No redirects.
    fn get_via(&self, url: &str, host: &str, port: u16) -> impl Future<Output = Result<Fetched, FetchError>> + Send;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SrvRecord {
    pub priority: u16,
    pub weight: u16,
    pub port: u16,
    pub target: String,
}

pub trait SrvLookup {
    /// The records of `name`; an empty list or an error when there are none.
    fn srv(&self, name: &str) -> impl Future<Output = Result<Vec<SrvRecord>, ()>> + Send;
}

fn valid_label(l: &str) -> bool {
    !l.is_empty() && l.len() <= 63 && l.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') && !l.starts_with('-') && !l.ends_with('-')
}

/// A node domain (FEDERATION.md §1.3 rule 1): lowercase labels, at least one dot, no port, no IP literal.
pub fn valid_domain(d: &str) -> bool {
    if d.is_empty() || d.len() > 253 || !d.contains('.') {
        return false;
    }
    let labels: Vec<&str> = d.split('.').collect();
    labels.iter().all(|l| valid_label(l)) && !labels.last().is_some_and(|l| l.bytes().all(|b| b.is_ascii_digit()))
}

/// `localhost:<port>` or `127.0.0.1:<port>` (a port is optional): a development node on this computer.
pub fn dev_host(d: &str) -> bool {
    let (host, port) = d.split_once(':').map_or((d, None), |(h, p)| (h, Some(p)));
    DEV_HOSTS.contains(&host) && port.is_none_or(|p| !p.is_empty() && p.len() <= 5 && p.parse::<u16>().is_ok_and(|n| n > 0))
}

fn endpoint(value: Option<&Value>, schemes: &[&str], dev: bool) -> Option<Url> {
    let url = Url::parse(value?.as_str()?).ok()?;
    let host = url.host_str()?;
    let secure = schemes[0];
    let ok_scheme = url.scheme() == secure || (dev && schemes.get(1) == Some(&url.scheme()) && DEV_HOSTS.contains(&host));
    (ok_scheme && url.username().is_empty() && url.password().is_none() && url.query().is_none() && url.fragment().is_none()).then_some(url)
}

/// Validates a discovery document for `domain`; `dev`: a development node on this computer (plain http allowed for
/// endpoints on this computer, its domain is `localhost`).
pub fn validate(body: &[u8], domain: &str, dev: bool) -> Option<Resolved> {
    let doc: Value = serde_json::from_slice(body).ok()?;
    if doc.get("tavrn").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let named = doc.get("domain")?.as_str()?;
    let host = domain.split(':').next().unwrap_or(domain);
    if !(named == domain || (dev && (named == "localhost" || named == host))) {
        return None;
    }
    let api = endpoint(doc.get("api"), &["https", "http"], dev)?;
    if !api.path().trim_end_matches('/').ends_with("/api/v1") {
        return None;
    }
    let ws = endpoint(doc.get("ws"), &["wss", "ws"], dev)?;
    let web = match doc.get("web") {
        Some(v) => endpoint(Some(v), &["https", "http"], dev)?,
        None => api.clone(),
    };
    Some(Resolved {
        domain: named.to_string(),
        api: api.as_str().trim_end_matches('/').to_string(),
        ws: ws.as_str().trim_end_matches('/').to_string(),
        web: web.origin().ascii_serialization(),
        source: Source::WellKnown,
    })
}

/// Resolves `input` (an identity domain) to its node.
pub async fn resolve(input: &str, fetcher: &impl Fetcher, srv: &impl SrvLookup) -> Result<Resolved, Failure> {
    let domain = input.trim().trim_end_matches('.').to_ascii_lowercase();
    let dev = dev_host(&domain);
    if !dev && !valid_domain(&domain) {
        return Err(Failure::new(DOMAIN_INVALID, Step::Input, &domain));
    }
    let scheme = if dev { "http" } else { "https" };

    // 1. The well-known on the identity domain itself.
    let after_404 = match fetcher.get(&format!("{scheme}://{domain}/.well-known/tavrn")).await {
        Ok(f) if f.status == 200 => {
            return validate(&f.body, &domain, dev).ok_or_else(|| Failure::new(INVALID, Step::WellKnown, &domain));
        }
        Ok(f) if f.status == 404 => true,
        Ok(_) | Err(FetchError::Refused) => return Err(Failure::new(UNREACHABLE, Step::WellKnown, &domain)),
        Err(FetchError::Transport) => false,
    };

    // 2. SRV (not for development nodes: a stopped one fails at once).
    if !dev {
        let mut records = srv.srv(&format!("_tavrn._tcp.{domain}")).await.unwrap_or_default();
        records.sort_by(|a, b| a.priority.cmp(&b.priority).then(b.weight.cmp(&a.weight)));
        for record in records.iter().take(MAX_SRV_TARGETS) {
            let target = record.target.trim_end_matches('.').to_ascii_lowercase();
            if !valid_domain(&target) || record.port == 0 {
                continue;
            }
            // A TLS failure (a certificate only for the target) skips the record like any transport failure.
            match fetcher.get_via(&format!("https://{domain}/.well-known/tavrn"), &target, record.port).await {
                Ok(f) if f.status == 200 => {
                    let found = validate(&f.body, &domain, false).ok_or_else(|| Failure::new(INVALID, Step::Srv, &domain))?;
                    return Ok(Resolved { source: Source::Srv, ..found });
                }
                _ => continue,
            }
        }
    }
    if !after_404 {
        let step = if dev { Step::WellKnown } else { Step::Srv };
        return Err(Failure::new(UNREACHABLE, step, &domain));
    }

    // 3. After a 404 only: the API on the domain itself.
    let api = format!("{scheme}://{domain}/api/v1");
    match fetcher.get(&format!("{api}/node")).await {
        Ok(f) if f.status == 200 && serde_json::from_slice::<Value>(&f.body).is_ok_and(|v| v.is_object()) => Ok(Resolved {
            domain: domain.clone(),
            ws: format!("{}://{domain}/api/v1/ws", if dev { "ws" } else { "wss" }),
            web: format!("{scheme}://{domain}"),
            api,
            source: Source::Domain,
        }),
        _ => Err(Failure::new(NOT_FOUND, Step::Direct, &domain)),
    }
}

// ---- The real fetcher and SRV lookup ------------------------------------------------------------------------------

/// HTTPS with verified TLS (rustls), at most 3 redirects to https on the same host, 5 s to connect, 10 s in total, the
/// body capped at [`MAX_DOCUMENT`]. The SRV step ([`Fetcher::get_via`]) connects to the target's addresses with the URL
/// still on the identity domain (`resolve_to_addrs`), so rustls verifies the certificate for the domain.
pub struct HttpFetcher {
    client: reqwest::Client,
    user_agent: String,
    /// Trust anchors instead of the platform's (tests).
    roots: Option<Vec<Vec<u8>>>,
    /// The address every SRV target connects to (tests).
    target_override: Option<std::net::IpAddr>,
}

impl HttpFetcher {
    /// With a test CA and every SRV target on `target`.
    #[cfg(test)]
    pub fn for_tests(version: &str, ca_der: Vec<u8>, target: std::net::IpAddr) -> Result<Self, String> {
        Ok(Self { roots: Some(vec![ca_der]), target_override: Some(target), ..Self::new(version)? })
    }

    pub fn new(version: &str) -> Result<Self, String> {
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        let policy = reqwest::redirect::Policy::custom(|attempt| {
            let same_host = attempt.previous().first().and_then(|u| u.host_str()) == attempt.url().host_str();
            if attempt.previous().len() > 3 || attempt.url().scheme() != "https" || !same_host { attempt.error("redirect refused") } else { attempt.follow() }
        });
        let client = client_builder()
            .redirect(policy)
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(10))
            .user_agent(format!("tavrn-desktop/{version}"))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self { client, user_agent: format!("tavrn-desktop/{version}"), roots: None, target_override: None })
    }
}

/// The HTTP client of the discovery: the platform's certificate verifier on the desktop; on Android Mozilla's root
/// certificates (reqwest's platform verifier needs a Kotlin component there; docs/ANDROID.md "Limits").
fn client_builder() -> reqwest::ClientBuilder {
    #[cfg(target_os = "android")]
    {
        let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
        let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
        if let Ok(config) = rustls::ClientConfig::builder_with_provider(provider).with_safe_default_protocol_versions() {
            let tls = config.with_root_certificates(roots).with_no_client_auth();
            return reqwest::Client::builder().tls_backend_preconfigured(tls);
        }
    }
    reqwest::Client::builder()
}

async fn read_capped(mut resp: reqwest::Response) -> Result<Fetched, FetchError> {
    let status = resp.status().as_u16();
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|_| FetchError::Transport)? {
        if body.len() + chunk.len() > MAX_DOCUMENT {
            return Err(FetchError::Refused);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Fetched { status, body })
}

impl Fetcher for HttpFetcher {
    fn get(&self, url: &str) -> impl Future<Output = Result<Fetched, FetchError>> + Send {
        let request = self.client.get(url).header("Accept", "application/json");
        async move {
            let resp = request.send().await.map_err(|e| if e.is_redirect() { FetchError::Refused } else { FetchError::Transport })?;
            read_capped(resp).await
        }
    }

    fn get_via(&self, url: &str, host: &str, port: u16) -> impl Future<Output = Result<Fetched, FetchError>> + Send {
        let (url, host, user_agent, roots, target_override) =
            (url.to_string(), host.to_string(), self.user_agent.clone(), self.roots.clone(), self.target_override);
        async move {
            let parsed = Url::parse(&url).map_err(|_| FetchError::Refused)?;
            let domain = parsed.host_str().filter(|_| parsed.scheme() == "https" && parsed.port().is_none()).ok_or(FetchError::Refused)?.to_string();
            // The target's addresses (the system's resolver), with the record's port: the URL has none, so it is used.
            let addrs: Vec<std::net::SocketAddr> = match target_override {
                Some(ip) => vec![std::net::SocketAddr::new(ip, port)],
                None => tauri::async_runtime::spawn_blocking(move || {
                    std::net::ToSocketAddrs::to_socket_addrs(&(host.as_str(), port)).map(|a| a.collect::<Vec<_>>())
                })
                .await
                .map_err(|_| FetchError::Transport)?
                .map_err(|_| FetchError::Transport)?,
            };
            if addrs.is_empty() {
                return Err(FetchError::Transport);
            }
            let mut builder = client_builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(10))
                .user_agent(user_agent)
                .resolve_to_addrs(&domain, &addrs);
            if let Some(roots) = roots {
                let certs = roots.iter().filter_map(|der| reqwest::Certificate::from_der(der).ok()).collect::<Vec<_>>();
                builder = builder.tls_certs_only(certs);
            }
            let client = builder.build().map_err(|_| FetchError::Transport)?;
            let resp = client.get(parsed).header("Accept", "application/json").send().await.map_err(|_| FetchError::Transport)?;
            if resp.status().is_redirection() {
                return Err(FetchError::Refused);
            }
            read_capped(resp).await
        }
    }
}

/// SRV records through the system's DNS configuration (hickory).
pub struct SystemSrv;

impl SrvLookup for SystemSrv {
    fn srv(&self, name: &str) -> impl Future<Output = Result<Vec<SrvRecord>, ()>> + Send {
        let name = name.to_string();
        async move {
            let resolver = hickory_resolver::TokioResolver::builder_tokio().and_then(|b| b.build()).map_err(|_| ())?;
            let lookup = resolver.srv_lookup(name).await.map_err(|_| ())?;
            Ok(lookup
                .answers()
                .iter()
                .filter_map(|r| match &r.data {
                    hickory_resolver::proto::rr::RData::SRV(srv) => Some(SrvRecord {
                        priority: srv.priority,
                        weight: srv.weight,
                        port: srv.port,
                        target: srv.target.to_ascii().trim_end_matches('.').to_ascii_lowercase(),
                    }),
                    _ => None,
                })
                .collect())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// Answers per URL (anything else: no server); SRV records per name.
    #[derive(Default)]
    struct Fake {
        answers: HashMap<String, Result<Fetched, FetchError>>,
        records: HashMap<String, Vec<SrvRecord>>,
        fetched: Mutex<Vec<String>>,
        srv_asked: Mutex<Vec<String>>,
    }

    impl Fake {
        fn answer(mut self, url: &str, status: u16, body: Value) -> Self {
            self.answers.insert(url.into(), Ok(Fetched { status, body: body.to_string().into_bytes() }));
            self
        }
        fn fail(mut self, url: &str, e: FetchError) -> Self {
            self.answers.insert(url.into(), Err(e));
            self
        }
        fn srv(mut self, name: &str, records: &[(u16, u16, u16, &str)]) -> Self {
            let list = records.iter().map(|&(priority, weight, port, target)| SrvRecord { priority, weight, port, target: target.into() }).collect();
            self.records.insert(name.into(), list);
            self
        }
        fn fetched(&self) -> Vec<String> {
            self.fetched.lock().map(|f| f.clone()).unwrap_or_default()
        }
        fn srv_asked(&self) -> Vec<String> {
            self.srv_asked.lock().map(|f| f.clone()).unwrap_or_default()
        }
    }

    impl Fetcher for Fake {
        fn get(&self, url: &str) -> impl Future<Output = Result<Fetched, FetchError>> + Send {
            if let Ok(mut f) = self.fetched.lock() {
                f.push(url.into());
            }
            let r = self.answers.get(url).cloned().unwrap_or(Err(FetchError::Transport));
            async move { r }
        }
        /// SRV step: the request names the identity domain, the connection goes to `host:port` (answers keyed by that).
        fn get_via(&self, url: &str, host: &str, port: u16) -> impl Future<Output = Result<Fetched, FetchError>> + Send {
            let key = format!("{url} via {host}:{port}");
            if let Ok(mut f) = self.fetched.lock() {
                f.push(key.clone());
            }
            let r = self.answers.get(&key).cloned().unwrap_or(Err(FetchError::Transport));
            async move { r }
        }
    }

    impl SrvLookup for Fake {
        fn srv(&self, name: &str) -> impl Future<Output = Result<Vec<SrvRecord>, ()>> + Send {
            if let Ok(mut s) = self.srv_asked.lock() {
                s.push(name.into());
            }
            let r = self.records.get(name).cloned().ok_or(());
            async move { r }
        }
    }

    fn doc(domain: &str, host: &str) -> Value {
        serde_json::json!({ "tavrn": 1, "domain": domain, "api": format!("https://{host}/api/v1"), "ws": format!("wss://{host}/api/v1/ws"), "web": format!("https://{host}"), "capabilities": [] })
    }

    fn run(domain: &str, fake: &Fake) -> Result<Resolved, Failure> {
        tauri::async_runtime::block_on(resolve(domain, fake, fake))
    }

    const WK: &str = "https://home.example/.well-known/tavrn";

    #[test]
    fn the_well_known_on_the_domain_with_delegation() {
        let fake = Fake::default().answer(WK, 200, doc("home.example", "app.home.example"));
        let found = run(" Home.Example ", &fake).unwrap_or_else(|e| unreachable!("{e:?}"));
        assert_eq!(
            found,
            Resolved {
                domain: "home.example".into(),
                api: "https://app.home.example/api/v1".into(),
                ws: "wss://app.home.example/api/v1/ws".into(),
                web: "https://app.home.example".into(),
                source: Source::WellKnown,
            }
        );
        assert!(fake.srv_asked().is_empty(), "SRV only when the domain serves no document");
    }

    #[test]
    fn invalid_documents_are_refused_at_their_step() {
        let mut bad = vec![];
        for (key, value) in [
            ("tavrn", serde_json::json!(2)),
            ("domain", serde_json::json!("other.example")),
            ("api", serde_json::json!("http://app.home.example/api/v1")),
            ("api", serde_json::json!("https://user:pw@app.home.example/api/v1")),
            ("api", serde_json::json!("https://app.home.example/api/v1?x=1")),
            ("api", serde_json::json!("https://app.home.example/api")),
            ("ws", serde_json::json!("ws://app.home.example/api/v1/ws")),
            ("web", serde_json::json!("https://app.home.example/#x")),
        ] {
            let mut d = doc("home.example", "app.home.example");
            d[key] = value;
            bad.push(d);
        }
        bad.push(serde_json::json!("not an object"));
        for d in bad {
            let fake = Fake::default().answer(WK, 200, d.clone());
            assert_eq!(run("home.example", &fake), Err(Failure::new(INVALID, Step::WellKnown, "home.example")), "{d}");
        }
    }

    #[test]
    fn after_a_404_the_srv_records_in_order() {
        let fake = Fake::default()
            .answer(WK, 404, serde_json::json!({}))
            .srv(
                "_tavrn._tcp.home.example",
                &[(20, 0, 443, "late.example"), (10, 1, 8443, "light.example"), (10, 9, 8443, "heavy.example."), (5, 0, 443, "10.0.0.1")],
            )
            .answer(&format!("{WK} via light.example:8443"), 200, doc("home.example", "light.example"));
        let found = run("home.example", &fake).unwrap_or_else(|e| unreachable!("{e:?}"));
        assert_eq!((found.source, found.api.as_str()), (Source::Srv, "https://light.example/api/v1"));
        // The IP literal is skipped; heavy (priority 10, weight 9) before light (weight 1); late is never reached. Every SRV
        // request is made for the identity domain (its certificate must be valid for it), connected to the target.
        assert_eq!(fake.fetched(), [WK.to_string(), format!("{WK} via heavy.example:8443"), format!("{WK} via light.example:8443")]);
    }

    #[test]
    fn an_srv_target_must_name_the_requested_domain() {
        let fake = Fake::default().answer(WK, 404, serde_json::json!({})).srv("_tavrn._tcp.home.example", &[(10, 0, 443, "host.example")]).answer(
            &format!("{WK} via host.example:443"),
            200,
            doc("host.example", "host.example"),
        );
        assert_eq!(run("home.example", &fake), Err(Failure::new(INVALID, Step::Srv, "home.example")));
    }

    #[test]
    fn after_a_404_without_srv_the_api_on_the_domain_is_the_last_attempt() {
        let fake =
            Fake::default().answer(WK, 404, serde_json::json!({})).answer("https://home.example/api/v1/node", 200, serde_json::json!({ "name": "Home" }));
        let found = run("home.example", &fake).unwrap_or_else(|e| unreachable!("{e:?}"));
        assert_eq!(
            (found.source, found.api.as_str(), found.ws.as_str(), found.web.as_str()),
            (Source::Domain, "https://home.example/api/v1", "wss://home.example/api/v1/ws", "https://home.example")
        );
        let nothing = Fake::default().answer(WK, 404, serde_json::json!({}));
        assert_eq!(run("home.example", &nothing), Err(Failure::new(NOT_FOUND, Step::Direct, "home.example")));
    }

    #[test]
    fn without_an_https_server_srv_then_unreachable_never_the_direct_attempt() {
        let fake = Fake::default().fail(WK, FetchError::Transport).srv("_tavrn._tcp.home.example", &[(10, 0, 443, "host.example")]).answer(
            &format!("{WK} via host.example:443"),
            200,
            doc("home.example", "host.example"),
        );
        assert_eq!(run("home.example", &fake).map(|f| f.source), Ok(Source::Srv));
        let down = Fake::default().fail(WK, FetchError::Transport);
        assert_eq!(run("home.example", &down), Err(Failure::new(UNREACHABLE, Step::Srv, "home.example")));
        assert!(!down.fetched().iter().any(|u| u.contains("/api/v1")), "no direct attempt without a 404");
    }

    #[test]
    fn other_statuses_and_refused_redirects_stop_at_the_well_known() {
        for f in [
            Fake::default().answer(WK, 500, serde_json::json!({})),
            Fake::default().answer(WK, 403, serde_json::json!({})),
            Fake::default().fail(WK, FetchError::Refused),
        ] {
            assert_eq!(run("home.example", &f), Err(Failure::new(UNREACHABLE, Step::WellKnown, "home.example")));
            assert!(f.srv_asked().is_empty());
        }
    }

    #[test]
    fn invalid_input() {
        for bad in ["", "home", "home.example:8443", "1.2.3.4", "user@home.example", "-a.example", "a..example", "évil.example"] {
            let fake = Fake::default();
            assert_eq!(run(bad, &fake).map_err(|e| (e.code, e.step)), Err((DOMAIN_INVALID, Step::Input)), "{bad}");
            assert!(fake.fetched().is_empty());
        }
    }

    #[test]
    fn a_development_node_on_this_computer_over_plain_http_without_srv() {
        let url = "http://127.0.0.1:8500/.well-known/tavrn";
        let local = serde_json::json!({ "tavrn": 1, "domain": "localhost", "api": "http://127.0.0.1:8500/api/v1", "ws": "ws://127.0.0.1:8500/api/v1/ws", "web": "http://localhost:5500" });
        let fake = Fake::default().answer(url, 200, local);
        let found = run("127.0.0.1:8500", &fake).unwrap_or_else(|e| unreachable!("{e:?}"));
        assert_eq!((found.domain.as_str(), found.api.as_str(), found.web.as_str()), ("localhost", "http://127.0.0.1:8500/api/v1", "http://localhost:5500"));
        let down = Fake::default();
        assert_eq!(run("localhost:8500", &down), Err(Failure::new(UNREACHABLE, Step::WellKnown, "localhost:8500")));
        assert!(down.srv_asked().is_empty());
        // Plain http endpoints only on this computer, also for development nodes.
        let remote = serde_json::json!({ "tavrn": 1, "domain": "localhost", "api": "http://evil.example/api/v1", "ws": "ws://127.0.0.1:8500/api/v1/ws" });
        assert_eq!(run("127.0.0.1:8500", &Fake::default().answer(url, 200, remote)).map_err(|e| e.code), Err(INVALID));
    }

    #[test]
    fn domains_and_dev_hosts() {
        assert!(valid_domain("home.example") && valid_domain("a-b.c.example"));
        assert!(!valid_domain("localhost") && !valid_domain("1.2.3.4") && !valid_domain("HOME.example"));
        assert!(dev_host("localhost:8080") && dev_host("127.0.0.1") && dev_host("127.0.0.1:8500"));
        assert!(!dev_host("127.0.0.2:80") && !dev_host("localhost:0") && !dev_host("localhost:99999") && !dev_host("evil.example:80"));
    }

    /// The real fetcher once against a node on this computer (a tiny HTTP server with a discovery document).
    #[test]
    fn the_real_fetcher_reads_a_local_node() {
        use std::io::{Read, Write};
        let Ok(listener) = std::net::TcpListener::bind("127.0.0.1:0") else { return };
        let port = listener.local_addr().map(|a| a.port()).unwrap_or_default();
        let body = serde_json::json!({ "tavrn": 1, "domain": "localhost", "api": format!("http://127.0.0.1:{port}/api/v1"), "ws": format!("ws://127.0.0.1:{port}/api/v1/ws") }).to_string();
        let server = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 2048];
                let n = stream.read(&mut buf).unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]).to_string();
                let _ =
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                return request;
            }
            String::new()
        });
        let fetcher = HttpFetcher::new("0.0.0-test").unwrap_or_else(|e| unreachable!("{e}"));
        let found = tauri::async_runtime::block_on(resolve(&format!("127.0.0.1:{port}"), &fetcher, &SystemSrv)).unwrap_or_else(|e| unreachable!("{e:?}"));
        assert_eq!(found.api, format!("http://127.0.0.1:{port}/api/v1"));
        assert_eq!(found.web, format!("http://127.0.0.1:{port}"), "no web: the API's origin");
        let request = server.join().unwrap_or_default();
        assert!(request.starts_with("GET /.well-known/tavrn HTTP/1.1"), "{request}");
        assert!(request.to_lowercase().contains("user-agent: tavrn-desktop/0.0.0-test"), "{request}");
    }

    /// A certificate and its PKCS#8 key (DER).
    type KeyPair = (Vec<u8>, Vec<u8>);

    /// A test CA and server certificates (DER), made with openssl in `dir`; None when a step fails.
    fn certificates(dir: &std::path::Path) -> Option<(Vec<u8>, [KeyPair; 2])> {
        let ossl = |args: &[&str]| std::process::Command::new("openssl").args(args).current_dir(dir).output().ok().filter(|o| o.status.success());
        ossl(&[
            "req",
            "-x509",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:P-256",
            "-nodes",
            "-keyout",
            "ca.key",
            "-out",
            "ca.pem",
            "-days",
            "2",
            "-subj",
            "/CN=tavrn test CA",
            "-addext",
            "basicConstraints=critical,CA:TRUE",
            "-addext",
            "keyUsage=critical,keyCertSign",
        ])?;
        ossl(&["x509", "-in", "ca.pem", "-outform", "DER", "-out", "ca.der"])?;
        let mut leaves = Vec::new();
        for name in ["home.test", "target.test"] {
            ossl(&[
                "req",
                "-newkey",
                "ec",
                "-pkeyopt",
                "ec_paramgen_curve:P-256",
                "-nodes",
                "-keyout",
                &format!("{name}.key"),
                "-out",
                &format!("{name}.csr"),
                "-subj",
                &format!("/CN={name}"),
                "-addext",
                &format!("subjectAltName=DNS:{name}"),
            ])?;
            ossl(&[
                "x509",
                "-req",
                "-in",
                &format!("{name}.csr"),
                "-CA",
                "ca.pem",
                "-CAkey",
                "ca.key",
                "-CAcreateserial",
                "-out",
                &format!("{name}.pem"),
                "-days",
                "2",
                "-copy_extensions",
                "copy",
            ])?;
            ossl(&["x509", "-in", &format!("{name}.pem"), "-outform", "DER", "-out", &format!("{name}.der")])?;
            ossl(&["pkcs8", "-topk8", "-nocrypt", "-in", &format!("{name}.key"), "-outform", "DER", "-out", &format!("{name}.key.der")])?;
            leaves.push((std::fs::read(dir.join(format!("{name}.der"))).ok()?, std::fs::read(dir.join(format!("{name}.key.der"))).ok()?));
        }
        let target = leaves.pop()?;
        let home = leaves.pop()?;
        Some((std::fs::read(dir.join("ca.der")).ok()?, [home, target]))
    }

    /// A TLS server on 127.0.0.1 with `cert`; answers every request with a discovery document of home.test and reports
    /// the `Host` header of each request it got.
    fn tls_server(cert: Vec<u8>, key: Vec<u8>) -> (u16, std::sync::mpsc::Receiver<String>) {
        use rustls::pki_types::{CertificateDer, PrivateKeyDer};
        use std::io::{Read, Write};
        let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
        let key = PrivateKeyDer::try_from(key).unwrap_or_else(|e| unreachable!("{e}"));
        let config = rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .and_then(|b| b.with_no_client_auth().with_single_cert(vec![CertificateDer::from(cert)], key))
            .unwrap_or_else(|e| unreachable!("{e}"));
        let config = std::sync::Arc::new(config);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap_or_else(|e| unreachable!("{e}"));
        let port = listener.local_addr().map(|a| a.port()).unwrap_or_default();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let Ok(conn) = rustls::ServerConnection::new(config.clone()) else { continue };
                let mut tls = rustls::StreamOwned::new(conn, stream);
                let mut buf = [0u8; 4096];
                let Ok(n) = tls.read(&mut buf) else { continue };
                let request = String::from_utf8_lossy(&buf[..n]).to_lowercase();
                let host = request.lines().find_map(|l| l.strip_prefix("host: ")).unwrap_or_default().trim().to_string();
                let _ = tx.send(host);
                let body = doc("home.test", "node.home.test").to_string();
                let _ = write!(tls, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = tls.flush();
                tls.conn.send_close_notify();
                let _ = tls.flush();
            }
        });
        (port, rx)
    }

    struct SrvTo(u16);
    impl SrvLookup for SrvTo {
        fn srv(&self, _name: &str) -> impl Future<Output = Result<Vec<SrvRecord>, ()>> + Send {
            let port = self.0;
            async move { Ok(vec![SrvRecord { priority: 0, weight: 0, port, target: "target.test".into() }]) }
        }
    }

    /// The SRV step with real TLS: the target's certificate must be valid for the identity domain.
    #[test]
    fn the_srv_target_needs_a_certificate_for_the_identity_domain() {
        let dir = std::env::temp_dir().join(format!("tavrn-resolve-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        if std::process::Command::new("openssl").arg("version").output().is_err() {
            return; // no openssl here
        }
        let (ca, [home, target]) = certificates(&dir).unwrap_or_else(|| unreachable!("openssl could not make the test certificates"));
        let _ = std::fs::remove_dir_all(&dir);
        let (good, good_hosts) = tls_server(home.0, home.1);
        let (impostor, impostor_hosts) = tls_server(target.0, target.1);
        let fetcher = HttpFetcher::for_tests("0.0.0-test", ca, std::net::Ipv4Addr::LOCALHOST.into()).unwrap_or_else(|e| unreachable!("{e}"));
        // home.test has no HTTPS server here: the direct well-known fails, the SRV record names the local servers.
        let spoofed = tauri::async_runtime::block_on(resolve("home.test", &fetcher, &SrvTo(impostor)));
        assert_eq!(spoofed, Err(Failure::new(UNREACHABLE, Step::Srv, "home.test")), "a certificate only for the target is refused");
        assert!(impostor_hosts.try_recv().is_err(), "no request reaches a server without a certificate for the domain");
        let found = tauri::async_runtime::block_on(resolve("home.test", &fetcher, &SrvTo(good))).unwrap_or_else(|e| unreachable!("{e:?}"));
        assert_eq!((found.source, found.api.as_str()), (Source::Srv, "https://node.home.test/api/v1"));
        assert_eq!(good_hosts.recv_timeout(Duration::from_secs(5)).ok().as_deref(), Some("home.test"));
    }
}
