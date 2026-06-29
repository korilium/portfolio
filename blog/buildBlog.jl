using CommonMark 
using Markdown
using Glob 

posts_dir = "blog/posts"
index_dir = "blog/"
output_dir = "blog/posts/generated"
mkpath(output_dir)  # Ensure output directory exists
posts = glob("*.md", posts_dir) # Find all markdown files

function make_side_links(posts) # Generate sidebar links
  item = String[] 
  for post in posts 
    name= splitext(basename(post))[1]
    push!(item, """<li><a href="$(name).html">$(name)</a></li>""")
  end
  return join(item, "\n")
end

sidebarLinks = make_side_links(posts) # Create sidebar HTML

parser = CommonMark.Parser() # Create a parser instance
CommonMark.enable!(parser, [
    CommonMark.TableRule(),
    CommonMark.DollarMathRule(),   # if you're using $...$ math
    CommonMark.FootnoteRule(),
])




# Wrap with your site’s HTML template
html_page = raw"""
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{TITLE}}</title>
  <!-- Favicon -->
  <link rel="icon" href="../../../img/favicon.svg">
    <script>
  (function () {
    const savedTheme = localStorage.getItem("theme");
    if (savedTheme === "light") {
      document.documentElement.setAttribute("data-theme", savedTheme);
    }
  })();
</script>
  <!-- Stylesheet -->
  <link href="../../../css/styles/styleBlog.css" rel="stylesheet">
  <script>
    MathJax = {
    tex: { inlineMath: [['$', '$'], ['\\(', '\\)']] },
    svg: { fontCache: 'global' }
    };
  </script>
  <script>
    // Immediately set theme before rendering
    (function() {
      const savedTheme = localStorage.getItem("theme");
      if (savedTheme === "light") {
        document.documentElement.classList.add("light");
      }
    })();
  </script>
<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js" async></script>


</head>
<body>
  <aside id="sidebar">
      <button id="close-sidebar" aria-label="Close menu">&times;</button>
    <h2>The peccon blog </h2>
    <ul>
      <li><a href="index.html">Home</a></li>
      {{sidebarLinks}}
    </ul>
  </aside>
  <main>
    <button id="open-sidebar" aria-label="Open menu">&#9776;</button>

    <label class="theme-switch">
      <input type="checkbox" id="theme-toggle">
      <span class="slider"></span>
    </label>
    <article>
      {{html_body}}
    </article>
  </main>
<script src="../../../js/toggleTheme.js"></script>
<script src="../../../js/toggleSideBar.js"></script>
</body>
</html>
"""


# --- HTML template for index page ---
index_template = raw"""
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Blog Index</title>
  <link rel="icon" href="../../../img/favicon.svg">
      <script>
  (function () {
    const savedTheme = localStorage.getItem("theme");
    if (savedTheme === "light") {
      document.documentElement.setAttribute("data-theme", savedTheme);
    }
  })();
</script>
  <link href="../../../css/styles/styleBlogIndex.css" rel="stylesheet">
</head>
  <body class="index" id="page-top" data-spy="scroll" data-target=".side-menu">
    <!-- Header -->
    <div class="header">
        <div class="menu-container">
            <ul class="menu">
                <li><a href="../../../index.html">Home</a></li>
                <li><a href="index.html">Blog</a></li>
                <li><a href="../../../playGround.html">Play Ground</a></li>
                <li><a href="../../../resume.html">CV</a></li>
                <li><a href="../../../project.html">Peccon</a></li>
            </ul>
        </div>
            </div>
    <label class="theme-switch">
      <input type="checkbox" id="theme-toggle">
      <span class="slider"></span>
    </label>
  </div>

    </div>


  <div>
    <div class="title-description">
      <div class="title">
        <h1>The Peccon Blog</h1>
      </div>
      <div class="description">
        <p>Welcome to the Peccon blog, where we explore the intersection of time and money. Dive into articles that
          unravel the complexities of financial planning, investment strategies, and personal growth. Our mission is to
          empower you with knowledge and insights to make informed decisions in a fast-paced world. Join us on this
          journey to master the art of balancing time and money effectively.</p>
      </div>
    </div>
    <div class="blog-overview">
      <a href="01.MPT.html" class="blog-card-link">
        <div class="blog-card">
          <div class="blog-content">
            <h3>Modern Portfolio Theory</h3>
            <p>Explore the principles of Modern Portfolio Theory (MPT) and learn how to optimize your investment portfolio by balancing risk and return...</p>
            <span class="meta">Jan 10, 2025 • Finance</span>
          </div>
        </div>
      </a>
      <a href="02.BlackjackWithRL.html" class="blog-card-link">
        <div class="blog-card">
          <div class="blog-content">
            <h3>Blackjack with Reinforcement Learning</h3>
            <p>Discover how reinforcement learning can be applied to playing blackjack...</p>
            <span class="meta">Jan 5, 2025 • Personal Finance</span>
          </div>
        </div>
      </a>
    </div>
  </div>

<script src="../../../js/toggleTheme.js"></script>
<script src="../../../js/toggleSideBar.js"></script>
</body>
</html>
"""


for mdfile in posts
  println("Processing: ", mdfile)

  open(mdfile, "r") do io 
    doc = CommonMark.parse(parser, io)
    html_body = CommonMark.html(doc)

    name= splitext(basename(mdfile))[1]
    title = replace(name, "_" => " ")


    # Inject title and sidebar links
    page = html_page |>
      x -> replace(x, "{{TITLE}}" => title) |>
      x -> replace(x, "{{sidebarLinks}}" => sidebarLinks) |>
      x -> replace(x, "{{html_body}}" => html_body)
      # x -> replace(x, "" => name) # Just to show you can chain more replacements

    outfile = joinpath(output_dir, name * ".html")
    mkpath(dirname(outfile))
    open(outfile, "w") do f
        write(f, page)
    end
  end
end 


# --- Generate blog index ---
println("Generating blog index page...")
sidebar = make_side_links(posts)
index_file = joinpath(output_dir, "index.html")
open(index_file, "w") do f
    page = replace(index_template, "{{SIDEBAR}}" => sidebar)
    write(f, page)
end