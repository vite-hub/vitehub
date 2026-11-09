/**
 * mitmproxy addon for the container runtime broker. It is the only network exit of a
 * caged Sandbox. It enforces the egress allowlist and swaps credential placeholders for
 * real values, only in HTTPS request headers sent to the hosts that a credential names.
 *
 * The design follows the broker of antfu/dev-container (MIT).
 */
export const containerBrokerAddon = String.raw`
import base64
import binascii
import ipaddress
import json
import os
import re

from mitmproxy import http

PLACEHOLDER = re.compile(r"vitehub-[A-Za-z_][A-Za-z0-9_]*-[0-9a-f]{32}")


def log(event, **fields):
    print(json.dumps({"event": event, **fields}), flush=True)


def normalize(host):
    return (host or "").lower().rstrip(".")


def authority_host(value):
    value = (value or "").strip()
    if value.startswith("["):
        return normalize(value[1:value.find("]")])
    return normalize(value.rpartition(":")[0] if value.count(":") == 1 else value)


def is_ip(host):
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


def host_matches(pattern, host, port):
    name, _, want_port = pattern.lower().partition(":")
    if int(want_port or "443") != port:
        return False
    if name.startswith("*."):
        return host.endswith(name[1:])
    return host == name


class Blocked(Exception):
    def __init__(self, code, why):
        super().__init__(why)
        self.code = code
        self.why = why


class Broker:
    def __init__(self):
        config = json.loads(os.environ["VITEHUB_BROKER_RULES"])
        self.policy = config["policy"]
        self.allow = tuple(config["allow"])
        self.secrets = {}
        for index, secret in enumerate(config["secrets"]):
            self.secrets[secret["placeholder"]] = {
                "hosts": tuple(secret["hosts"]),
                "name": secret["name"],
                "value": os.environ.get("VITEHUB_BROKER_SECRET_%d" % index, ""),
            }
        log("ready", policy=self.policy, secrets=[s["name"] for s in self.secrets.values()])

    def allowed(self, host, port):
        if self.policy == "open":
            return True
        patterns = self.allow + tuple(h for s in self.secrets.values() for h in s["hosts"])
        return any(host_matches(p, host, port) for p in patterns)

    def block(self, flow, blocked):
        request = flow.request
        log("block", host=request.host, port=request.port, method=request.method,
            path=request.path.partition("?")[0], code=blocked.code, why=blocked.why)
        flow.metadata["vitehub_logged"] = True
        flow.response = http.Response.make(
            403,
            "[%s] %s\n" % (blocked.code, blocked.why),
            {"content-type": "text/plain; charset=utf-8", "x-vitehub-sandbox-diagnostic": blocked.code},
        )

    def http_connect(self, flow):
        # A tunnel that does not carry HTTP never reaches request(), so check egress here too.
        host = normalize(flow.request.host)
        if not self.allowed(host, flow.request.port):
            self.block(flow, Blocked("SANDBOX_BROKER_B001", "Host %s is not on the Sandbox egress allowlist." % host))

    def request(self, flow):
        request = flow.request
        # Inside a CONNECT tunnel, mitmproxy takes host and port from the tunnel target,
        # not from the Host header that the Sandbox controls.
        host = normalize(request.host)
        port = request.port
        try:
            # The TLS server name and the Host header pick the upstream site on shared hosting.
            # Both must name the CONNECT target, or a request could reach another site there.
            # Clients send no server name for an IP address.
            sni = flow.client_conn.sni
            if request.scheme == "https" and normalize(sni) != host and not (sni is None and is_ip(host)):
                raise Blocked("SANDBOX_BROKER_B007", "The TLS server name does not match the host %s." % host)
            if request.host_header is not None and authority_host(request.host_header) != host:
                raise Blocked("SANDBOX_BROKER_B007", "The Host header does not match the host %s." % host)
            if not self.allowed(host, port):
                raise Blocked("SANDBOX_BROKER_B001", "Host %s is not on the Sandbox egress allowlist." % host)
            if PLACEHOLDER.search(request.url):
                raise Blocked("SANDBOX_BROKER_B002", "A credential placeholder is in the URL. Send credentials only in request headers.")
            injected = []

            def swap(match):
                secret = self.secrets.get(match.group(0))
                if secret is None:
                    raise Blocked("SANDBOX_BROKER_B003", "The request has an unknown credential placeholder. Read the credential from its environment variable again.")
                if not any(host_matches(p, host, port) for p in secret["hosts"]):
                    raise Blocked("SANDBOX_BROKER_B004", "%s is not bound to %s." % (secret["name"], host))
                if request.scheme != "https":
                    raise Blocked("SANDBOX_BROKER_B005", "The broker sends %s only over HTTPS." % secret["name"])
                if not secret["value"]:
                    raise Blocked("SANDBOX_BROKER_B006", "%s has no value." % secret["name"])
                if secret["name"] not in injected:
                    injected.append(secret["name"])
                return secret["value"]

            headers = []
            for name, value in request.headers.items(multi=True):
                headers.append((name, substitute_header(value, lambda text: PLACEHOLDER.sub(swap, text))))
        except Blocked as blocked:
            self.block(flow, blocked)
            return
        if injected:
            request.headers = http.Headers(
                [(k.encode("utf-8", "surrogateescape"), v.encode("utf-8", "surrogateescape")) for k, v in headers]
            )
            flow.metadata["vitehub_injected"] = injected

    def response(self, flow):
        if flow.metadata.get("vitehub_logged"):
            return
        request = flow.request
        log("request", host=request.host, port=request.port, method=request.method,
            path=request.path.partition("?")[0], status=flow.response.status_code if flow.response else 0,
            injected=flow.metadata.get("vitehub_injected", []))


def substitute_header(value, substitute):
    scheme, _, credentials = value.partition(" ")
    if scheme.lower() == "basic" and credentials:
        try:
            decoded = base64.b64decode(credentials.strip(), validate=True).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError):
            return substitute(value)
        replaced = substitute(decoded)
        if replaced != decoded:
            return scheme + " " + base64.b64encode(replaced.encode("utf-8")).decode("ascii")
        return value
    return substitute(value)


addons = [Broker()]
`;

/** Starts mitmdump with the addon. The CA private key stays in the broker container. */
export const containerBrokerEntrypoint = [
  "set -eu",
  "mkdir -p /tmp/vitehub-broker",
  "printf '%s' \"$VITEHUB_BROKER_ADDON\" > /tmp/vitehub-broker/addon.py",
  "exec mitmdump --listen-host 0.0.0.0 --listen-port 8080 --quiet --set connection_strategy=lazy --set rawtcp=false --set confdir=/tmp/vitehub-broker -s /tmp/vitehub-broker/addon.py",
].join("\n");

export const containerBrokerCaPath = "/tmp/vitehub-broker/mitmproxy-ca-cert.pem";
