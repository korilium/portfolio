(pwd() != @__DIR__) && cd(@__DIR__) # allow starting app from bin/ dir

using Portfolio
const UserApp = Portfolio
Portfolio.main()
