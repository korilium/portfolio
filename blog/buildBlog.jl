# Builds the blog: one HTML page per post, the blog index, and the "Latest writing"
# list on the home page. Run from the repository root:  julia blog/buildBlog.jl
using CommonMark
using Dates

const POSTS_DIR = "blog/posts"
const OUTPUT_DIR = "blog/posts/generated"
const HOME_PAGE = "index.html"
const ROOT = "../../../"          # from OUTPUT_DIR back to the site root

# --- Posts -------------------------------------------------------------------
# One entry per published post, in reading order. A markdown file without an entry
# here is not built (e.g. drafts that are still empty).
#   slug    output file name (keep it stable: it is the post's URL)
#   status  "" for finished posts, otherwise shown as a badge (e.g. "In progress")
const POSTS = [
  (file = "01.BelgiumBonds.md", slug = "01.BelgiumBonds",
   title = "Belgian Government Bonds",
   summary = "How Belgian government bonds (OLOs) are priced in the market, and how their yield curve is derived.",
   date = Date(2026, 7), series = "Interest rates", status = ""),
  (file = "02.intermezzo: Stochastic Calculus.md", slug = "02.StochasticCalculus",
   title = "From Theory to the Vasicek Model",
   summary = "A first-principles route from the short rate and stochastic calculus to bond prices under the Vasicek model.",
   date = Date(2026, 10), series = "Interest rates", status = "In progress"),
  (file = "04.optimalPensionDesign_I.md", slug = "04.optimalPensionDesign_I",
   title = "Optimal Pension Design I: A Naive Approach",
   summary = "A simple environment in which a Monte Carlo RL agent learns whether contributing to a pension plan is optimal.",
   date = Date(2026, 7), series = "Pension design", status = "In progress"),
  (file = "05.optimalPensionDesign_II.md", slug = "05.optimalPensionDesign_II",
   title = "Optimal Pension Design II: A High-Dimensional Take",
   summary = "Bringing in the risk and variability a pension plan faces, and how they change its valuation.",
   date = Date(2026, 7), series = "Pension design", status = "In progress"),
  (file = "06.MPT.md", slug = "06.MPT",
   title = "Modern Portfolio Theory",
   summary = "The principles of Modern Portfolio Theory: balancing a portfolio's risk against its return.",
   date = Date(2025, 1), series = "Portfolio theory", status = ""),
]

# --- Helpers -----------------------------------------------------------------

esc(s) = replace(string(s), "&" => "&amp;", "<" => "&lt;", ">" => "&gt;", "\"" => "&quot;")
fmtdate(d) = Dates.format(d, "U yyyy")
strip_tags(s) = replace(s, r"<[^>]*>" => "")

function slugify(s)
  s = lowercase(strip_tags(s))
  s = replace(s, r"\\\(.*?\\\)" => "")           # inline maths
  s = replace(s, r"[^a-z0-9]+" => "-")
  strip(s, '-')
end

status_tag(p) = isempty(p.status) ? "" : """ <span class="tag tag--warm">$(esc(lowercase(p.status)))</span>"""
postnum(p) = first(split(p.slug, "."))          # "01.BelgiumBonds" -> "01"

# Rewrites the relative links of a snippet taken from the home page so they work
# from `prefix` (absolute URLs, mailto: and #anchors are left alone).
relink(html, prefix) = replace(html, r"(href|src)=\"(?!https?:|mailto:|#)([^\"]*)\"" => SubstitutionString("\\1=\"$(prefix)\\2\""))

# The theme script, header and footer are shared with the rest of the site and are
# taken from the home page, so the navigation only has to be edited in one place.
function site_shell()
  home = read(HOME_PAGE, String)
  grab(rx) = (m = match(rx, home); m === nothing ? error("site shell: $(rx) not found in $(HOME_PAGE)") : m.match)
  theme = grab(r"<script>\s*\(function \(\) \{\s*var t;.*?crossorigin>"s)
  header = grab(r"<a class=\"skip-link\".*?</header>"s)
  footer = grab(r"<footer class=\"site-footer\">.*?</footer>"s)
  header = replace(header, " aria-current=\"page\"" => "")
  header = replace(relink(header, ROOT), "href=\"$(ROOT)blog/posts/generated/index.html\"" => "href=\"index.html\" aria-current=\"page\"")
  (theme = theme, header = header, footer = relink(footer, ROOT))
end

function post_list(posts, prefix)
  items = map(posts) do p
    """
          <li>
            <a href="$(prefix)$(p.slug).html">
              <span class="num">$(postnum(p))</span>
              <span class="line">
                <h3>$(esc(p.title))</h3>$(status_tag(p))
                <span class="leader"></span>
                <span class="meta">$(fmtdate(p.date))</span>
              </span>
              <p>$(esc(p.summary))</p>
            </a>
          </li>"""
  end
  """<ol class="post-list">\n$(join(items, "\n"))\n        </ol>"""
end

function head(shell, title, description)
  """
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>$(esc(title))</title>
  <meta name="description" content="$(esc(description))">
  <link rel="icon" href="$(ROOT)img/favicon.svg">
  $(shell.theme)
  <link href="$(ROOT)css/styles/styleBlog.css" rel="stylesheet">"""
end

# --- Post pages ----------------------------------------------------------------

parser = CommonMark.Parser()
CommonMark.enable!(parser, [
  CommonMark.TableRule(),
  CommonMark.DollarMathRule(),
  CommonMark.FootnoteRule(),
])

function render_body(md)
  html = CommonMark.html(parser(md))
  # the title comes from POSTS, so drop a leading "# ..." heading
  html = replace(html, r"^\s*<h1>.*?</h1>\s*"s => "")
  # give every h2 an id and collect them for the table of contents
  toc = Tuple{String,String}[]
  seen = Dict{String,Int}()
  html = replace(html, r"<h2>(.*?)</h2>"s => function (m)
    inner = match(r"<h2>(.*?)</h2>"s, m).captures[1]
    id = slugify(inner)
    isempty(id) && (id = "section")
    n = get(seen, id, 0); seen[id] = n + 1
    n > 0 && (id = "$(id)-$(n)")
    push!(toc, (id, inner))
    """<h2 id="$(id)">$(inner)</h2>"""
  end)
  html, toc
end

function pager(i)
  prev = i > 1 ? POSTS[i-1] : nothing
  next = i < length(POSTS) ? POSTS[i+1] : nothing
  link(p, rel, label) = p === nothing ? "<span></span>" :
    """<a class="pager-$(rel)" href="$(p.slug).html" rel="$(rel)"><span class="meta">$(label)</span>$(esc(p.title))</a>"""
  """<nav class="post-pager" aria-label="More posts">
        $(link(prev, "prev", "← Previous"))
        $(link(next, "next", "Next →"))
      </nav>"""
end

function post_page(shell, i, body, toc, minutes)
  p = POSTS[i]
  toc_html = isempty(toc) ? "" : """
      <nav class="toc" aria-label="On this page">
        <h2>On this page</h2>
        <ol>
          $(join(["<li><a href=\"#$(id)\">$(strip_tags(t))</a></li>" for (id, t) in toc], "\n          "))
        </ol>
      </nav>"""
  others = join(["""<li><a href="$(q.slug).html"$(q.slug == p.slug ? " aria-current=\"page\"" : "")>$(esc(q.title))</a></li>""" for q in POSTS], "\n          ")
  """
<!DOCTYPE html>
<html lang="en">

<head>
  $(head(shell, "$(p.title) — Ignace Decocq", p.summary))
  <script>
    MathJax = {
      tex: { inlineMath: [['\$', '\$'], ['\\\\(', '\\\\)']] },
      svg: { fontCache: 'global' }
    };
  </script>
  <script src="https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-mml-chtml.js" async></script>
</head>

<body>
  $(shell.header)

  <main id="content" class="container post-layout">
    <article class="post">
      <header class="post-header">
        <a class="post-back" href="index.html">← the peccon blog</a>
        <p class="post-kicker meta">no. $(postnum(p)) · $(esc(lowercase(p.series)))$(status_tag(p))</p>
        <h1>$(esc(p.title))</h1>
        <p class="post-summary">$(esc(p.summary))</p>
        <p class="meta">$(fmtdate(p.date)) · $(minutes) min read</p>
      </header>
      <div class="post-body">
$(body)
      </div>
      $(pager(i))
    </article>

    <aside class="post-aside">$(toc_html)
      <nav class="series-nav" aria-label="All posts">
        <h2>All posts</h2>
        <ul>
          $(others)
        </ul>
      </nav>
    </aside>
  </main>

  $(shell.footer)

  <script src="$(ROOT)js/toggleTheme.js"></script>
</body>

</html>
"""
end

# --- Index page --------------------------------------------------------------

function index_page(shell)
  sections = String[]
  for series in unique(p.series for p in POSTS)
    push!(sections, """
      <section class="series">
        <h2>$(esc(series))</h2>
        $(post_list(filter(p -> p.series == series, POSTS), ""))
      </section>""")
  end
  """
<!DOCTYPE html>
<html lang="en">

<head>
  $(head(shell, "Blog — Ignace Decocq", "Writing on time, money, and the decisions that connect them: financial planning, interest-rate models and pension design."))
</head>

<body>
  $(shell.header)

  <main id="content" class="container">
    <header class="page-head">
      <h1>The Peccon Blog</h1>
      <p class="lede">Writing on time, money, and the decisions that connect them. I cover financial planning,
        investment, and the occasional detour into whatever I'm testing in the playground — always with an eye on
        how things behave in practice.</p>
    </header>
$(join(sections, "\n"))
  </main>

  $(shell.footer)

  <script src="$(ROOT)js/toggleTheme.js"></script>
</body>

</html>
"""
end

# --- Build ---------------------------------------------------------------------

mkpath(OUTPUT_DIR)
shell = site_shell()

for (i, p) in enumerate(POSTS)
  println("Processing: ", p.file)
  md = read(joinpath(POSTS_DIR, p.file), String)
  body, toc = render_body(md)
  minutes = max(1, ceil(Int, length(split(md)) / 220))
  write(joinpath(OUTPUT_DIR, p.slug * ".html"), post_page(shell, i, body, toc, minutes))
end

println("Generating blog index page...")
write(joinpath(OUTPUT_DIR, "index.html"), index_page(shell))

println("Updating latest posts on the home page...")
latest = first(sort(collect(enumerate(POSTS)), by = ((i, p),) -> (p.date, i), rev = true), 3)
home = read(HOME_PAGE, String)
block = "<!-- latest-posts:start -->\n        $(post_list(last.(latest), "blog/posts/generated/"))\n        <!-- latest-posts:end -->"
write(HOME_PAGE, replace(home, r"<!-- latest-posts:start -->.*?<!-- latest-posts:end -->"s => block))
