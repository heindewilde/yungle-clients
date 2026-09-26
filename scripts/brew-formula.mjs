// Writes the Homebrew formula for a published yungle-cli version to stdout:
//   node scripts/brew-formula.mjs [version]      (default: latest on npm)
// The tap (heindewilde/homebrew-yungle) holds the output as Formula/yungle.rb.
// Built from the registry, not from this checkout, so the sha256 is of the
// exact tarball users will download.
import { createHash } from 'node:crypto';

const version = process.argv[2] ?? 'latest';
const meta = await (await fetch(`https://registry.npmjs.org/yungle-cli/${version}`)).json();
if (!meta.dist?.tarball) throw new Error(`yungle-cli@${version} is not on npm`);
const tgz = Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer());
const sha256 = createHash('sha256').update(tgz).digest('hex');

process.stdout.write(`class Yungle < Formula
  desc "Send and sync files with Yungle, private EU-hosted file transfer"
  homepage "https://yungle.co/developers/cli"
  url "${meta.dist.tarball}"
  sha256 "${sha256}"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/yungle --version")
    assert_match "download a transfer", shell_output("#{bin}/yungle --help")
  end
end
`);
